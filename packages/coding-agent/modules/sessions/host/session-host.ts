import {
	type AgentId,
	type AgentTurnId,
	createAgentRuntime,
	createStatefulAgent,
	type SessionRecord,
	type StatefulAgent,
	toSessionMessageId,
	toSubmissionId,
} from "@wincode/agent-core";
import type { ProviderCollection, ThinkingLevel } from "@wincode/ai";
import { isNull, logger, omitUndefined } from "@wincode/utils";
import {
	type AgentRegistry,
	resolveActiveAgentId,
} from "@/modules/agents/registry";
import type { SessionCacheWarming } from "@/modules/prompt-cache/cache-warming";
import { createSessionCacheWarming } from "@/modules/prompt-cache/cache-warming";
import {
	createInteractiveProviderController,
	type InteractiveProviderController,
} from "@/modules/providers/interactive-provider-controller";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { toSteeringMessageId } from "@/shared/identifiers";
import { AgentSessionImpl } from "../agent-session/agent-session";
import type {
	AgentSession,
	AgentSessionInternalPort,
	AgentSessionPorts,
	SessionQueuedSubmission,
	SessionSteeringMessage,
} from "../agent-session/types";
import type { SessionCompaction } from "../compaction/types";
import {
	applySessionContextEdits,
	failedAttemptContextEdit,
	isEditableSessionContextTarget,
	isFailedAttemptContextEdit,
	sessionContextEditSchema,
} from "../context-edits";
import { rebuildUneditedSessionContext } from "../context-projection";
import {
	isSessionToolPart,
	type SessionMessage,
	sanitizeInterruptedSessionMessages,
} from "../message";
import {
	type InteractiveSessionProviderCollection,
	ProviderCollectionUnavailableError,
	pluginProvidersFromRuntime,
} from "../provider-collection";
import { restoreSelection } from "../selection";
import type { SessionSdkEvent } from "../session-events";
import {
	requireSessionWriteReady,
	SessionWriteOutcomeError,
} from "../storage/session-jsonl-store";
import type {
	SessionForkProvenance,
	SessionUsageEntry,
} from "../storage/session-store";
import { projectSessionRecords } from "../transcript-projection";
import {
	createSessionUsageLedger,
	type SessionUsageLedger,
} from "../usage/session-usage-ledger";
import { createAgentSessionAdapters } from "./agent-session-adapters";
import { assertPluginProviderRegistrationSnapshot } from "./agent-session-turn-runner";
import { IMPORTED_SESSION_COMPACTION_ACTIVATION_REQUIRED_MESSAGE } from "./imported-session-agent";
import { assertPluginProviderSelectionOwner } from "./provider-selection-ownership";
import type {
	SessionHost,
	SessionHostOptions,
	SessionStoreCapabilities,
} from "./types";

/**
 * The durable Session projection used to initialize the Agent Session, plus
 * the session-row facts Session Selection resolves against. This is where
 * durable records become a Session Transcript and Session Context.
 */
type OpenedSession = Readonly<{
	compactions: SessionCompaction[];
	forkProvenance: SessionForkProvenance | undefined;
	context: SessionMessage[];
	model: ProviderModelSelection | undefined;
	steeringMessages: SessionSteeringMessage[];
	transcript: SessionMessage[];
	thinkingLevel: ThinkingLevel | undefined;
	usageEntries: SessionUsageEntry[];
}>;
const closingHosts = new Map<SessionHostOptions["sessionId"], Promise<void>>();

const isInteractiveSessionProviderCollection = (
	providers: ProviderCollection
): providers is InteractiveSessionProviderCollection =>
	"preparePluginProviderRegistrations" in providers &&
	typeof providers.preparePluginProviderRegistrations === "function";

const requireProviderCollection = (
	providerCollection: ProviderCollection | undefined
): ProviderCollection => {
	if (providerCollection === undefined) {
		throw new ProviderCollectionUnavailableError();
	}
	return providerCollection;
};

const pluginProviderIdsForExecutionMode = (
	executionMode: SessionHostOptions["executionMode"],
	providerModel: ProviderModelSelection | undefined
): readonly string[] | undefined => {
	if (executionMode === "interactive") {
		return;
	}
	if (providerModel === undefined) {
		return [];
	}
	return [providerModel.providerId];
};

const waitForClosingHost = async (
	sessionId: SessionHostOptions["sessionId"]
): Promise<void> => {
	const closing = closingHosts.get(sessionId);
	if (closing !== undefined) {
		await closing.catch(() => undefined);
	}
};
/**
 * Prefix growth preserves a warmed request. The active turn's assistant message
 * is outside that captured prompt and streams in place; earlier rewrites or
 * truncation invalidate the stable prefix.
 */
const sessionContextExtends = (
	previous: readonly SessionMessage[],
	next: readonly SessionMessage[]
): boolean =>
	previous.length <= next.length &&
	previous.every((message, index) => {
		const candidate = next[index];
		if (
			candidate === undefined ||
			message.id !== candidate.id ||
			message.role !== candidate.role
		) {
			return false;
		}
		if (index === previous.length - 1 && message.role === "assistant") {
			return true;
		}
		return Bun.deepEquals(message.parts, candidate.parts, true);
	});

const interruptedSteeringFailure =
	"Session closed before provider processing could be confirmed; deliberate retry required.";

/**
 * Overflow recovery can finish a continuation with completed Tool Calls that
 * remain active after compaction. The cut can move before their turn, so use the
 * active durable Tool rows rather than the compaction's first-kept message.
 */
const recoveredContinuationTurnIds = (
	records: readonly SessionRecord[],
	compactions: readonly SessionCompaction[],
	activeMessageIds: ReadonlySet<SessionMessage["id"]>
): ReadonlySet<AgentTurnId> => {
	const overflowRecoveryTurnIds = new Set(
		compactions.flatMap((compaction) =>
			compaction.trigger === "overflow" &&
			compaction.summary.overflowSourceTurnId !== undefined
				? [compaction.summary.overflowSourceTurnId]
				: []
		)
	);
	const retainedToolTurnIds = new Set<AgentTurnId>();
	for (const record of records) {
		if (
			record.outcome.kind === "tool" &&
			record.messages.some(({ id }) => activeMessageIds.has(id))
		) {
			retainedToolTurnIds.add(record.turnId);
		}
	}
	const recoveredTurnIds = new Set<AgentTurnId>();
	for (const [recordIndex, record] of records.entries()) {
		if (
			record.outcome.kind !== "assistant" ||
			(record.outcome.terminal.kind !== "failed" &&
				record.outcome.terminal.kind !== "cancelled") ||
			!overflowRecoveryTurnIds.has(record.turnId) ||
			!retainedToolTurnIds.has(record.turnId)
		) {
			continue;
		}
		const sourceUserMessageId = record.messages.find(
			(message) =>
				message.role === "assistant" &&
				message.metadata?.sourceUserMessageId !== undefined
		)?.metadata?.sourceUserMessageId;
		if (sourceUserMessageId === undefined) {
			continue;
		}
		const completedContinuation = records
			.slice(recordIndex + 1)
			.some(
				(candidate) =>
					candidate.outcome.kind === "assistant" &&
					candidate.outcome.terminal.kind === "completed" &&
					candidate.messages.some(
						(message) =>
							message.metadata?.sourceUserMessageId === sourceUserMessageId
					)
			);
		if (completedContinuation) {
			recoveredTurnIds.add(record.turnId);
		}
	}
	return recoveredTurnIds;
};

const restoreSteeringMessages = (
	records: readonly SessionRecord[],
	transcript: readonly SessionMessage[],
	session: {
		model?: ProviderModelSelection;
		thinkingLevel?: ThinkingLevel;
	}
): SessionSteeringMessage[] =>
	records.flatMap((record) =>
		record.messages.flatMap((recordMessage) => {
			const message = transcript.find(({ id }) => id === recordMessage.id);
			const metadata = message?.metadata;
			const status = metadata?.submissionStatus;
			if (
				message?.role !== "user" ||
				metadata === undefined ||
				(status !== "pending" && status !== "failed") ||
				metadata.submissionId === undefined ||
				metadata.model === undefined
			) {
				return [];
			}
			const text = message.parts
				.filter(
					(
						part
					): part is Extract<
						SessionMessage["parts"][number],
						{ type: "text" }
					> => part.type === "text"
				)
				.map(({ text: partText }) => partText)
				.join("");
			const files = message.parts.flatMap((part) =>
				part.type === "file" ? [part] : []
			);
			const model = metadata.model;
			return [
				{
					id: toSteeringMessageId(`steering-${message.id}`),
					input: {
						agent: metadata.agent ?? record.agentId,
						composition: { files, text },
						files,
						messageId: message.id,
						model,
						sessionModel: session.model ?? model,
						sessionThinkingLevel: session.thinkingLevel ?? undefined,
						submissionId: toSubmissionId(metadata.submissionId),
						turnId: record.turnId,
						userText: text,
						...omitUndefined({
							thinkingLevel: metadata.thinkingLevel,
						}),
					},
					message,
					recordId: record.id,
					status,
					...omitUndefined({ reason: metadata.submissionFailure }),
				},
			];
		})
	);
/**
 * Reads one session's durable state and projects it into the Agent Session's
 * initial state: the Session Transcript as the surface presents it, the
 * Session Context rebuilt around the latest compaction, and compaction history.
 *
 * The Context is derived from the un-annotated projection — display annotation
 * is the surface's, and never reaches what the model is sent.
 */
const openSession = async (
	capabilities: SessionStoreCapabilities,
	sessionId: SessionHostOptions["sessionId"],
	providerModel?: ProviderModelSelection
): Promise<OpenedSession> => {
	const store = capabilities.getStore();
	let historyPath = await store.readSessionHistoryPath(sessionId);
	const [usageEntries, forkProvenance] = await Promise.all([
		store.listSessionUsageEntries(sessionId),
		store.getSessionForkProvenance(sessionId),
	]);
	const loadedRecords = historyPath.records;
	const interrupted = loadedRecords.flatMap((record) =>
		record.messages.flatMap((message) => {
			const submissionId = message.metadata?.submissionId;
			if (
				message.role !== "user" ||
				message.metadata?.submissionStatus !== "processing" ||
				submissionId === undefined
			) {
				return [];
			}
			return [
				{
					failure: interruptedSteeringFailure,
					messageId: message.id,
					recordId: record.id,
					status: "failed" as const,
					submissionId: toSubmissionId(submissionId),
				},
			];
		})
	);
	if (interrupted.length > 0) {
		await Promise.all(
			interrupted.map(async (submission) =>
				requireSessionWriteReady(
					await store.updateSessionSubmission({ ...submission, sessionId })
				)
			)
		);
	}
	if (interrupted.length > 0) {
		historyPath = await store.readSessionHistoryPath(sessionId);
	}
	const records = historyPath.records;
	const compactions = historyPath.compactions;
	const transcript = sanitizeInterruptedSessionMessages(
		projectSessionRecords(records)
	);
	const contextEdits = [...historyPath.contextEdits];
	const latestContextEdits = new Map(
		contextEdits.map((edit) => [edit.targetId, edit] as const)
	);
	const uneditedContext = rebuildUneditedSessionContext(
		transcript,
		compactions
	);
	const activeMessageIds = new Set(uneditedContext.map(({ id }) => id));
	const recoveredTurnIds = recoveredContinuationTurnIds(
		records,
		compactions,
		activeMessageIds
	);
	const failedTurnIds = new Set(
		records.flatMap((record) =>
			record.outcome.kind === "assistant" &&
			(record.outcome.terminal.kind === "failed" ||
				record.outcome.terminal.kind === "cancelled")
				? [record.turnId]
				: []
		)
	);
	for (const record of records) {
		if (
			!failedTurnIds.has(record.turnId) ||
			recoveredTurnIds.has(record.turnId)
		) {
			continue;
		}
		for (const message of record.messages) {
			if (message.role === "user" || message.id === "skill-context") {
				continue;
			}
			const targetId = toSessionMessageId(message.id);
			const latestEdit = latestContextEdits.get(targetId);
			if (
				latestEdit?.replacement === null &&
				(isFailedAttemptContextEdit(latestEdit.operationId) ||
					!message.parts.some(isSessionToolPart))
			) {
				continue;
			}
			const edit = failedAttemptContextEdit(record.turnId, targetId);
			requireSessionWriteReady(await store.appendContextEdit(sessionId, edit));
			contextEdits.push(edit);
			latestContextEdits.set(targetId, edit);
		}
	}
	const context = applySessionContextEdits(uneditedContext, contextEdits);
	const selectedModel = providerModel ?? historyPath.model;
	const selectedThinkingLevel = historyPath.thinkingLevel;
	return {
		compactions,
		context,
		model: selectedModel,
		steeringMessages: restoreSteeringMessages(records, transcript, {
			model: selectedModel,
			thinkingLevel: selectedThinkingLevel,
		}),
		transcript,
		thinkingLevel: selectedThinkingLevel,
		usageEntries,
		forkProvenance,
	};
};

/**
 * Re-exposes Session and Agent Turn Events through Host listeners. Observers
 * see each event after the owning Session has applied its state transition.
 */
const withEventChannel = (
	ports: AgentSessionPorts,
	publish: (event: SessionSdkEvent) => void
): AgentSessionPorts => ({
	...ports,
	emitCompactionEvent: publish,
	turnRunner: {
		...ports.turnRunner,
		run: (request) =>
			ports.turnRunner.run({
				...request,
				callbacks: {
					...request.callbacks,
					onEvent: async (event) => {
						await request.callbacks.onEvent(event);
						publish(event);
					},
					onTerminal: async (event) => {
						await request.callbacks.onTerminal(event);
						publish(event);
					},
				},
			}),
	},
});

/**
 * Opens one session and owns the assembly's lifetime. Its factory is
 * asynchronous because opening is construction, not a Session Command: the
 * Transcript, Context, and compactions used to initialize the Agent Session
 * are projected here; creating the Agent Session itself stays synchronous.
 *
 * The consumer that constructs a Host owns calling `shutdown`. Capabilities are
 * read through the getters the caller supplied, so a long session keeps seeing
 * the connections, configuration, and catalogs it was built with.
 */
export const createSessionHost = async ({
	autoContinue = true,
	capabilities,
	executionMode,
	providerModel,
	providerCollection: prevalidatedProviderCollection,
	sessionId,
}: SessionHostOptions): Promise<SessionHost> => {
	await waitForClosingHost(sessionId);
	const sessionStore = capabilities.getStore();
	const sessionWriter = await sessionStore.acquireSessionWriter(
		sessionId,
		executionMode === undefined ? {} : { executionMode }
	);
	const eventListeners = new Set<(event: SessionSdkEvent) => void>();
	let agentSession: AgentSession | undefined;
	let agentSessionInternalPort: AgentSessionInternalPort | undefined;
	let isShutDown = false;
	let shutdownPromise: Promise<void> | undefined;
	let statefulAgent: StatefulAgent<SessionQueuedSubmission> | undefined;
	let providerCollection: ProviderCollection | undefined;
	let providerController: InteractiveProviderController | undefined;
	// The warmer belongs to the loaded Host, not a single Agent Turn; retain it across idle turns.
	let cacheWarming: SessionCacheWarming | undefined;
	let usageLedger: SessionUsageLedger | undefined;
	let unsubscribeContext: (() => void) | undefined;
	let unsubscribeProviderComposition: (() => void) | undefined;
	let importActivationPending = false;
	let importActivationInFlight: Promise<void> | undefined;
	const activateImportedSession = async (): Promise<void> => {
		if (!importActivationPending) {
			return;
		}
		if (importActivationInFlight !== undefined) {
			return await importActivationInFlight;
		}
		const confirmActivation = sessionStore.confirmSessionImportActivation;
		if (confirmActivation === undefined) {
			throw new Error(
				"Imported Session activation cannot be recorded by this Session store."
			);
		}
		const activation = (async () => {
			await confirmActivation(sessionId);
			importActivationPending = false;
		})();
		importActivationInFlight = activation;
		try {
			await activation;
		} finally {
			if (importActivationInFlight === activation) {
				importActivationInFlight = undefined;
			}
		}
	};

	/**
	 * Reports one event to the Host's observers. Everything the Agent Session
	 * reads has already been reported through its own callbacks, so a listener
	 * that takes a Session Snapshot sees what the event did. A failing observer
	 * cannot change session state or stop the turn, as with the Agent Session's
	 * own emitter.
	 */
	const publish = (event: SessionSdkEvent): void => {
		if (isShutDown) {
			return;
		}
		for (const listener of [...eventListeners]) {
			try {
				listener(event);
			} catch {
				// The turn continues; only this observer loses the event.
			}
		}
	};
	const shutdown = (): Promise<void> => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}
		isShutDown = true;
		void logger.debug("Session Host shutdown started", {
			operation: "session-host",
			phase: "shutdown",
		});
		const activeAgentSession = agentSession;
		const activeInternalPort = agentSessionInternalPort;
		unsubscribeContext?.();
		unsubscribeProviderComposition?.();
		const cacheWarmingShutdown = cacheWarming?.dispose() ?? Promise.resolve();
		usageLedger?.dispose();
		let agentSessionShutdown: Promise<void> = Promise.resolve();
		if (activeAgentSession !== undefined) {
			const snapshot = activeAgentSession.getSnapshot();
			if (snapshot.isCompacting) {
				void activeAgentSession.cancelCompaction();
			}
			// Session shutdown aborts provider work and waits for it to unwind before
			// releasing the writer, including any durable checkpoint in progress.
			try {
				agentSessionShutdown =
					activeInternalPort?.shutdown() ?? Promise.resolve();
			} catch (error) {
				agentSessionShutdown = Promise.reject(error);
			}
		}
		eventListeners.clear();
		const closingShutdown = (async () => {
			try {
				const results = await Promise.allSettled([
					agentSessionShutdown,
					statefulAgent?.shutdown() ?? Promise.resolve(),
					cacheWarmingShutdown,
				]);
				const cleanupResults = await Promise.allSettled([
					providerCollection?.close() ?? Promise.resolve(),
				]);
				const failure = [...results, ...cleanupResults].find(
					(result): result is PromiseRejectedResult =>
						result.status === "rejected"
				);
				if (failure !== undefined) {
					throw failure.reason;
				}
			} finally {
				await sessionWriter.release();
			}
		})();
		shutdownPromise = closingShutdown;
		closingHosts.set(sessionId, closingShutdown);
		void closingShutdown.then(
			() => {
				void logger.debug("Session Host shutdown completed", {
					operation: "session-host",
					phase: "shutdown-completed",
				});
				if (closingHosts.get(sessionId) === closingShutdown) {
					closingHosts.delete(sessionId);
				}
			},
			() => {
				if (closingHosts.get(sessionId) === closingShutdown) {
					closingHosts.delete(sessionId);
				}
			}
		);
		return closingShutdown;
	};
	try {
		importActivationPending =
			(await sessionStore.isSessionImportActivationPending?.(sessionId)) ??
			false;
		const selectedHistoryPath =
			await sessionStore.readSessionHistoryPath(sessionId);
		const selectedProviderModel = providerModel ?? selectedHistoryPath.model;
		const sessionWorkManager = capabilities.getSessionHostManager();
		const withAsyncSessionWork = async <Result>(
			action: () => Promise<Result>,
			onRejected: (reason: string) => Result
		): Promise<Result> => {
			const admission = sessionWorkManager.tryAcquireSessionWork(sessionId);
			if (admission.kind === "rejected") {
				return onRejected(admission.reason);
			}
			try {
				return await action();
			} finally {
				admission.release();
			}
		};
		const allowedPluginProviderIds = pluginProviderIdsForExecutionMode(
			executionMode,
			selectedProviderModel
		);
		const pluginRuntime = capabilities.getPluginRuntime?.();
		const allowedPluginProviderSources = pluginProvidersFromRuntime(
			pluginRuntime,
			sessionId,
			allowedPluginProviderIds
		);
		const sessionProviderCollection = requireProviderCollection(
			prevalidatedProviderCollection ??
				(await capabilities.createProviderCollection?.(
					pluginRuntime,
					sessionId,
					allowedPluginProviderIds,
					allowedPluginProviderSources
				))
		);
		providerCollection = sessionProviderCollection;
		assertPluginProviderRegistrationSnapshot(
			allowedPluginProviderSources,
			sessionProviderCollection
		);
		let opened = await openSession(
			capabilities,
			sessionId,
			selectedProviderModel
		);
		const sessionRuntime = createAgentRuntime({
			providerCollection: sessionProviderCollection,
		});
		providerController = createInteractiveProviderController(
			sessionProviderCollection,
			isInteractiveSessionProviderCollection(sessionProviderCollection)
				? {
						getPluginProviderComposition:
							sessionProviderCollection.getPluginProviderComposition,
						getPluginProviderRegistrations:
							sessionProviderCollection.getPluginProviderRegistrations,
						getTrustedPluginProviderRegistrations: () =>
							capabilities
								.getPluginRuntime?.()
								?.getProviderRegistrations(sessionId) ?? [],
						getTrustedPluginProviderRuntime: () =>
							capabilities.getPluginRuntime?.(),
						loginOpenAIOAuth: sessionProviderCollection.loginOpenAIOAuth,
						getDiscoverableProviderIds:
							sessionProviderCollection.getDiscoverableProviderIds,
						getCompositionRevision:
							sessionProviderCollection.getCompositionRevision,
						subscribeComposition:
							sessionProviderCollection.subscribeComposition,
						supportsModelDiscovery:
							sessionProviderCollection.supportsModelDiscovery,
						withSessionWork: (action) =>
							withAsyncSessionWork(action, (reason) => {
								throw new Error(reason);
							}),
					}
				: undefined
		);
		const initialRegistry = capabilities.getRegistry();
		const resolveOpenedSelection = (registry: AgentRegistry | null) =>
			restoreSelection({
				messages: opened.transcript,
				// The opened Session carries the durable session-level choice.
				row: opened,
				...(isNull(registry)
					? {}
					: {
							resolveAgent: (agentId: AgentId) =>
								resolveActiveAgentId(registry, agentId),
						}),
			});
		const initialSelection = resolveOpenedSelection(initialRegistry);
		const selectedHostModel = selectedProviderModel ?? initialSelection?.model;
		if (selectedHostModel !== undefined) {
			assertPluginProviderSelectionOwner(
				selectedHostModel,
				capabilities,
				sessionProviderCollection,
				sessionId
			);
		}
		await providerController.restoreModels(selectedHostModel?.providerId);
		const sessionUsageLedger = createSessionUsageLedger({
			initialEntries: opened.usageEntries,
			sessionId,
			store: capabilities.getStore(),
		});
		usageLedger = sessionUsageLedger;
		cacheWarming = createSessionCacheWarming({
			providerCollection: sessionProviderCollection,
			usageLedger: sessionUsageLedger,
		});
		if (isInteractiveSessionProviderCollection(sessionProviderCollection)) {
			unsubscribeProviderComposition =
				sessionProviderCollection.subscribeComposition(() =>
					cacheWarming?.cancel()
				);
		}
		const openedStatefulAgent = createStatefulAgent<SessionQueuedSubmission>({
			getQueuedSubmissionId: ({ id }) => id,
			runtime: sessionRuntime,
		});
		statefulAgent = openedStatefulAgent;
		const ports: AgentSessionPorts = withEventChannel(
			createAgentSessionAdapters({
				cacheWarming,
				capabilities,
				usageLedger: sessionUsageLedger,
				providerCollection: sessionProviderCollection,
				isShutDown: () => isShutDown,
				sessionId,
				statefulAgent: openedStatefulAgent,
				withSessionWork: (action) =>
					withAsyncSessionWork(action, (reason) => {
						throw new Error(reason);
					}),
			}),
			publish
		);
		const initialAgent = initialSelection?.agent;
		const openedAgentSession = new AgentSessionImpl({
			initialCompactions: opened.compactions,
			...omitUndefined({
				forkContinuationMessageId: opened.forkProvenance?.targetMessageId,
			}),
			...omitUndefined({
				initialAgent,
				initialSessionModel: opened.model ?? initialSelection?.model,
				initialSessionThinkingLevel:
					opened.thinkingLevel ?? initialSelection?.thinkingLevel,
			}),
			initialContext: opened.context,
			initialSteeringMessages: opened.steeringMessages,
			initialTranscript: opened.transcript,
			ports,
			sessionId,
		});
		agentSessionInternalPort = openedAgentSession.internalPort;
		agentSession = openedAgentSession;
		let observedContext = openedAgentSession.getSnapshot().context;
		unsubscribeContext = openedAgentSession.subscribe(() => {
			const nextContext = openedAgentSession.getSnapshot().context;
			if (!sessionContextExtends(observedContext, nextContext)) {
				cacheWarming?.cancel();
			}
			observedContext = nextContext;
		});
		const initialSnapshot = openedAgentSession.getSnapshot();
		if (
			autoContinue &&
			!importActivationPending &&
			initialSnapshot.steeringMessages[0]?.status === "pending"
		) {
			await openedAgentSession.continue();
		}
		const guardedAgentSession: AgentSession = Object.freeze({
			cancel: openedAgentSession.cancel,
			cancelCompaction: openedAgentSession.cancelCompaction,
			compact: (command) =>
				withAsyncSessionWork(
					() => {
						if (importActivationPending) {
							throw new Error(
								IMPORTED_SESSION_COMPACTION_ACTIVATION_REQUIRED_MESSAGE
							);
						}
						return openedAgentSession.compact(command);
					},
					(reason) => {
						throw new Error(reason);
					}
				),
			continue: () =>
				withAsyncSessionWork(
					async () => {
						await activateImportedSession();
						return await openedAgentSession.continue();
					},
					(reason) => ({ kind: "rejected" as const, reason })
				),
			getSnapshot: openedAgentSession.getSnapshot,
			interrupt: openedAgentSession.interrupt,
			interruptAll: openedAgentSession.interruptAll,
			onSubmissionEvent: openedAgentSession.onSubmissionEvent,
			prompt: (input) =>
				withAsyncSessionWork(
					async () => {
						await activateImportedSession();
						return await openedAgentSession.prompt(input);
					},
					(reason) => ({ rejected: true, reason })
				),
			recallWaitingMessages: openedAgentSession.recallWaitingMessages,
			send: (input) =>
				withAsyncSessionWork(
					async () => {
						await activateImportedSession();
						return await openedAgentSession.send(input);
					},
					(reason) => ({ rejected: true as const, reason })
				),
			steer: () =>
				withAsyncSessionWork(
					() => openedAgentSession.steer(),
					(reason) => ({ kind: "rejected" as const, reason })
				),
			subscribe: openedAgentSession.subscribe,
		});
		void logger.debug("Session Host opened", {
			operation: "session-host",
			phase: "opened",
		});
		const interactiveProviderCollection =
			providerCollection !== undefined &&
			isInteractiveSessionProviderCollection(providerCollection)
				? providerCollection
				: undefined;

		return {
			agentSession: guardedAgentSession,
			blockExecution: (error) =>
				openedAgentSession.internalPort.blockExecution(error),
			reportStorageError: (error) =>
				openedAgentSession.internalPort.reportStorageError(error),
			editContext: async (input) => {
				const edit = sessionContextEditSchema.parse(input);
				if (isFailedAttemptContextEdit(edit.operationId)) {
					throw new Error("Context edit operation ID uses a reserved prefix.");
				}
				const previousEdits = (
					await sessionStore.readSessionHistoryPath(sessionId)
				).contextEdits;
				const previousOperation = previousEdits.find(
					({ operationId }) => operationId === edit.operationId
				);
				if (previousOperation !== undefined) {
					if (!Bun.deepEquals(previousOperation, edit, true)) {
						throw new Error(
							"Context edit operation ID was already used with a different payload."
						);
					}
					return;
				}
				const snapshot = openedAgentSession.getSnapshot();
				const rawContext = rebuildUneditedSessionContext(
					snapshot.transcript,
					snapshot.compactions
				);
				if (
					!isEditableSessionContextTarget(
						snapshot.transcript,
						rawContext,
						edit.targetId
					)
				) {
					throw new Error(
						"Context edit target is not an active durable message."
					);
				}
				const context = applySessionContextEdits(rawContext, [
					...previousEdits,
					edit,
				]);
				try {
					requireSessionWriteReady(
						await sessionStore.appendContextEdit(sessionId, edit)
					);
				} catch (error) {
					if (error instanceof Error) {
						openedAgentSession.internalPort.reportStorageError(error);
					}
					throw error;
				}
				openedAgentSession.internalPort.replaceContext(context);
				openedStatefulAgent.invalidateContext();
			},
			navigateHistory: async (request) => {
				const { targetEntryId } = request;
				const previousPath =
					await sessionStore.readSessionHistoryPath(sessionId);
				const writeOutcome = await sessionStore.navigateSessionHistory(
					sessionId,
					request
				);
				if (writeOutcome.kind === "not-committed") {
					return {
						kind: "rejected",
						code: writeOutcome.error.code,
						reason: writeOutcome.error.message,
						writeOutcome,
					};
				}
				if (writeOutcome.kind === "indeterminate") {
					const error = new SessionWriteOutcomeError(writeOutcome);
					openedAgentSession.internalPort.reportStorageError(error);
					return {
						kind: "indeterminate",
						reason: writeOutcome.error.message,
						writeOutcome,
					};
				}
				if (writeOutcome.sequence <= previousPath.historyGeneration) {
					return {
						kind: "unchanged",
						activeLeafId: previousPath.activeLeafId,
					};
				}
				if (writeOutcome.projection === "blocked") {
					const error = new SessionWriteOutcomeError(writeOutcome);
					openedAgentSession.internalPort.reportStorageError(error);
					return {
						kind: "committed-blocked",
						activeLeafId: targetEntryId,
						reason: error.message,
						writeOutcome,
					};
				}
				try {
					const nextOpened = await openSession(capabilities, sessionId);
					await providerController?.restoreModels(nextOpened.model?.providerId);
					cacheWarming?.cancel();
					opened = nextOpened;
					const nextSelection = resolveOpenedSelection(
						capabilities.getRegistry()
					);
					openedAgentSession.internalPort.replaceHistory({
						compactions: nextOpened.compactions,
						context: nextOpened.context,
						selection: {
							agent: nextSelection?.agent,
							model: nextOpened.model ?? nextSelection?.model,
							thinkingLevel:
								nextOpened.thinkingLevel ?? nextSelection?.thinkingLevel,
						},
						steeringMessages: nextOpened.steeringMessages,
						transcript: nextOpened.transcript,
					});
					openedStatefulAgent.invalidateContext();
					const nextPath = await sessionStore.readSessionHistoryPath(sessionId);
					return {
						kind: "navigated",
						activeLeafId: nextPath.activeLeafId,
						writeOutcome,
					};
				} catch (error) {
					const navigationError =
						error instanceof Error
							? error
							: new Error("Session history projection could not be restored.");
					openedAgentSession.internalPort.blockExecution(navigationError);
					return {
						kind: "committed-blocked",
						activeLeafId: targetEntryId,
						reason: navigationError.message,
						writeOutcome,
					};
				}
			},
			forkSession: (checkpoint, operationId) =>
				sessionStore.forkSessionWithHeldWriter(
					sessionId,
					checkpoint,
					operationId
				),
			withSessionWork: withAsyncSessionWork,
			assertCurrentPluginProviderRegistrationSnapshot: () =>
				assertPluginProviderRegistrationSnapshot(
					pluginProvidersFromRuntime(
						capabilities.getPluginRuntime?.(),
						sessionId,
						allowedPluginProviderIds
					),
					sessionProviderCollection
				),
			...(providerCollection === undefined ? {} : { providerCollection }),
			...(providerController === undefined ? {} : { providerController }),
			...(interactiveProviderCollection === undefined
				? {}
				: {
						prepareProviderComposition: async (
							nextPluginRuntime,
							{ includePluginProviders = true } = {}
						) =>
							interactiveProviderCollection.preparePluginProviderRegistrations(
								includePluginProviders
									? pluginProvidersFromRuntime(nextPluginRuntime, sessionId)
									: []
							),
						failProviderCompositionClosed: () =>
							interactiveProviderCollection.failClosed(),
					}),
			getSelection: () => resolveOpenedSelection(capabilities.getRegistry()),
			getSnapshot: openedAgentSession.getSnapshot,
			getCacheWarmingStatus: () => cacheWarming?.getStatus() ?? "idle",
			cancelCacheWarming: () => cacheWarming?.cancel(),
			getSessionUsageEntries: () => usageLedger?.getEntries() ?? [],
			isImportedSessionActivationPending: () => importActivationPending,
			activateImportedSession,
			onEvent: (listener) => {
				eventListeners.add(listener);
				return () => eventListeners.delete(listener);
			},
			shutdown,
			subscribe: (listener) => {
				const notify = (): void => {
					if (!isShutDown) {
						listener();
					}
				};
				const unsubscribeAgent = openedAgentSession.subscribe(notify);
				const unsubscribeWarming = cacheWarming?.subscribe(notify);
				const unsubscribeUsage = usageLedger?.subscribe(notify);
				return () => {
					unsubscribeAgent();
					unsubscribeWarming?.();
					unsubscribeUsage?.();
				};
			},
		};
	} catch (error) {
		await shutdown();
		throw error;
	}
};

export type {
	SessionCapabilities,
	SessionHost,
	SessionHostOptions,
} from "./types";
