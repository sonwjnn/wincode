import {
	type AgentTurnId,
	createAgentTurnId,
	type SessionMessageId,
	type ToolCallId,
	toSessionMessageId,
} from "@wincode/agent-core";
import {
	getErrorMessage,
	isError,
	isNull,
	isUndefined,
	omitUndefined,
} from "@wincode/runtime-utils";
import {
	toQueuedSubmissionId,
	toSteeringMessageId,
} from "@/shared/identifiers";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionInput,
	CompactSessionResult,
} from "../compaction/compaction";
import { SessionCompactionError } from "../compaction/error";

import {
	isContextOverflowFailure,
	OverflowRecoveryError,
	prepareOverflowReplayMessages,
} from "../compaction/overflow-recovery";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import {
	createSessionUserMessage,
	type SessionFilePart,
	type SessionMessage,
} from "../message";
import type {
	SessionSendInput,
	SessionSendOutcome,
	SessionSubmissionComposition,
} from "../session-operation";
import { createSessionOperation } from "../session-operation";
import { buildUserSessionRecord } from "../storage/session-record";
import {
	createSubmissionPipeline,
	type SubmissionPipeline,
	sessionSendCancelled,
} from "./submission";
import { interruptSessionContext } from "./turn";
import type {
	SessionApprovalOutcome,
	SessionCompactionCommand,
	SessionEngine,
	SessionEngineOptions,
	SessionExecution,
	SessionExecutionInput,
	SessionOverflowRecoveryCommand,
	SessionOverflowRecoveryOutcome,
	SessionOverflowRecoveryTarget,
	SessionOverflowReplayOutcome,
	SessionQueuedSendInput,
	SessionQueuedSubmission,
	SessionSnapshot,
	SessionSteeringMessage,
	SessionViewState,
	SessionWaitingMessage,
	SessionWaitingMessageId,
} from "./types";
import {
	acceptsSteeringMessages,
	exposedViewState,
	hasChanged,
	primaryEntry,
} from "./utils";

/** The deadline one Agent Turn submission runs with. */
const AGENT_TURN_DEADLINE_MS = 43_200_000;

/** The reason a submission that arrives after the session ended is refused. */
const SHUT_DOWN_SEND_ERROR = "The session has ended.";

/** The reason a queued submission's attachments could not be kept. */
const QUEUED_ATTACHMENT_ERROR = "Attachment data could not be stored.";

/** The reason a Steering Message carrying attachments is refused. */
const STEERING_ATTACHMENT_ERROR =
	"A Steering Message carries text only: attachments are not accepted.";

/** The reason a Steering Message invoking a Skill is refused. */
const STEERING_SKILL_ERROR =
	"A Steering Message cannot invoke a Skill: it carries text only.";

/** The reason a Steering Message that is not a fresh prompt is refused. */
const STEERING_INVOCATION_ERROR =
	"A Steering Message carries text only: it cannot resend or edit another message.";

/** The attachment blobs one queued composition holds. */
const queuedAttachmentIds = ({
	composition,
}: SessionQueuedSendInput): string[] =>
	composition.files.flatMap(({ attachmentId }) =>
		isUndefined(attachmentId) ? [] : [attachmentId]
	);

/**
 * The single owner of one session's live state and the only writer to it.
 * Observers read a Session Snapshot and never write; the engine replaces the
 * snapshot instead of mutating it.
 */
export const createSessionEngine = ({
	initialCompactions = [],
	initialContext,
	initialTranscript,
	ports,
	sessionId,
}: SessionEngineOptions): SessionEngine => {
	let state: SessionSnapshot = {
		approvals: [],
		catalogDiagnostic: null,
		compactions: [...initialCompactions],
		compactionError: null,
		context: [...(initialContext ?? initialTranscript)],
		error: null,
		executions: [],
		isCompacting: false,
		queuedSubmissions: [],
		steeringMessages: [],
		transcript: [...initialTranscript],
		turnActive: false,
		viewState: undefined,
	};
	/**
	 * The compaction command the Engine is running, kept for its abort handle and
	 * for callers that join it. Whether a request may run at all is the Session
	 * Compaction module's decision, never this record's.
	 */
	let compactionCommand:
		| {
				abort: () => void;
				promise: Promise<CompactSessionResult>;
				/** Resolves once the Session Compaction module has admitted the request. */
				registered: Promise<void>;
		  }
		| undefined;
	const listeners = new Set<() => void>();
	/**
	 * The settlement of each pending approval, keyed by its registry id. A
	 * request is removed before its settlement is published, so a second route
	 * finds nothing to settle and can never settle the same request twice.
	 */
	const pendingApprovals = new Map<
		string,
		(outcome: SessionApprovalOutcome) => void
	>();
	/**
	 * The user messages that have used their one overflow recovery attempt. The
	 * attempt belongs to the message the Agent Turn answers — the replayed turn
	 * answers the same one — so a replayed turn can never chain into another
	 * recovery, and no send or command can reset an attempt that is under way.
	 */
	const recoveryAttempts = new Set<SessionMessageId>();
	/**
	 * The waiters of each live execution, resolved when that execution ends, so
	 * work that must not run during an Agent Turn can wait for it to end instead
	 * of guessing whether it has.
	 */
	const executionEndWaiters = new Map<AgentTurnId, (() => void)[]>();
	let approvalCounter = 0;
	let isShutDown = false;
	let shutdownPromise: Promise<void> | undefined;
	/**
	 * Session records delivered by the Steering Lane are started at the Model
	 * Step boundary and intentionally do not block that step. Shutdown must still
	 * await them before the Session Host can release its lease.
	 */
	const pendingDurableWrites = new Set<Promise<void>>();
	/**
	 * Every public compaction request remains tracked through joined admission,
	 * including a request whose owner finishes before its own settings resolve.
	 */
	const pendingCompactions = new Set<Promise<CompactSessionResult>>();
	/**
	 * How many submission runs hold the send lane. A run can overlap another's
	 * tail — an overflow replay starts once the failed turn's execution ends,
	 * which can precede the run that proposed it — so the lane is counted rather
	 * than flagged, and it is free only at zero.
	 */
	let laneRuns = 0;
	/** Whether the drain loop is walking the Submission Queue. */
	let draining = false;
	const publish = (changes: Partial<SessionSnapshot>): void => {
		if (!hasChanged(state, changes)) {
			return;
		}
		state = { ...state, ...changes };
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// An observer cannot change session state.
			}
		}
	};
	/** Settles one request: publishes its decision and wakes its waiter, once. */
	const settleApproval = (
		id: string,
		outcome: SessionApprovalOutcome
	): void => {
		const resolveApproval = pendingApprovals.get(id);
		if (isUndefined(resolveApproval)) {
			return;
		}
		pendingApprovals.delete(id);
		publish({
			approvals: state.approvals.map((approval) =>
				approval.id === id ? { ...approval, decision: outcome } : approval
			),
		});
		resolveApproval(outcome);
	};
	const requestApproval = (
		request: ToolApprovalRequest
	): Promise<SessionApprovalOutcome> => {
		// A session that has shut down has nothing to ask: the request settles
		// immediately so its Tool Gate evaluation can never wait forever.
		if (isShutDown) {
			return Promise.resolve({ decision: "reject" });
		}
		const id = request.toolCallId ?? `session-${approvalCounter++}`;
		// One identifier addresses one pending request. A request that reuses a
		// pending Tool Call Identifier is refused instead of replacing the request
		// the panel still shows, so neither evaluation can be left waiting.
		if (pendingApprovals.has(id)) {
			return Promise.resolve({ decision: "reject" });
		}
		const { promise, resolve } =
			Promise.withResolvers<SessionApprovalOutcome>();
		pendingApprovals.set(id, resolve);
		publish({
			approvals: [
				...state.approvals,
				{
					id,
					request,
					target: isUndefined(request.toolCallId) ? "session" : "tool-call",
				},
			],
		});
		return promise;
	};
	const closeApprovals = (feedback?: string): void => {
		const pending = state.approvals.filter((approval) =>
			isUndefined(approval.decision)
		);
		// The newest pending request — the panel on top of the stack — carries
		// the typed feedback; every sibling is rejected without it.
		const selectedId = isUndefined(feedback) ? undefined : pending.at(-1)?.id;
		for (const approval of pending) {
			settleApproval(
				approval.id,
				approval.id === selectedId
					? { decision: "reject", feedback }
					: { decision: "reject" }
			);
		}
	};
	const applyContext = (messages: readonly SessionMessage[]): void => {
		publish({ context: [...messages] });
	};
	const mergeTranscript = (
		messages: readonly SessionMessage[]
	): readonly SessionMessage[] => {
		const merged = [...state.transcript];
		for (const message of messages) {
			if (isCompactionSummaryMessage(message)) {
				continue;
			}
			const index = merged.findIndex(({ id }) => id === message.id);
			if (index === -1) {
				merged.push(message);
			} else {
				merged[index] = message;
			}
		}
		publish({ transcript: merged });
		return merged;
	};
	const recordCompaction = (entry: SessionCompaction): void => {
		if (state.compactions.some(({ id }) => id === entry.id)) {
			return;
		}
		publish({ compactions: [...state.compactions, entry] });
	};
	const setCompacting = (value: boolean): void => {
		publish({ isCompacting: value });
	};
	const setCompactionError = (error: Error | null): void => {
		publish({ compactionError: error });
	};
	/**
	 * The settings one compaction command runs with: the resolved compaction
	 * settings of its Model Target plus the request overhead of the Agent Turn
	 * execution in flight, so the compaction reserves what the next turn sends.
	 */
	const compactionSettingsFor = async (
		model: CompactSessionInput["model"]
	): Promise<CompactSessionInput["settings"]> => {
		const settings = await ports.resolveCompactionSettings(model);
		return {
			compactionOverheadTokens: ports.runtime.requestOverheadTokens(),
			enabled: settings.enabled,
			keepRecentTokens: settings.keepRecentTokens,
			maxMediaAttachments: settings.maxMediaAttachments,
			maxMediaBytes: settings.maxMediaBytes,
			maxMediaTokens: settings.maxMediaTokens,
			modelContextLimit: settings.modelContextLimit,
			reserveTokens: settings.reserveTokens,
			thresholdTokens: settings.thresholdTokens,
		};
	};
	/** A command that carries its own transcript update merges it before running. */
	const compactionSource = (
		command: SessionCompactionCommand
	): readonly SessionMessage[] => {
		if (!isUndefined(command.sourceMessages)) {
			return [...command.sourceMessages];
		}
		if (!isUndefined(command.nextMessages)) {
			return mergeTranscript(command.nextMessages);
		}
		return state.transcript;
	};
	const compactionRequest = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[],
		signal: AbortSignal
	): Promise<CompactSessionInput> => ({
		model: command.model,
		session: { messages, sessionId },
		settings: await compactionSettingsFor(command.model),
		trigger: command.trigger,
		...omitUndefined({ focus: command.focus, variant: command.variant }),
		signal,
	});
	/**
	 * Runs a command the module admitted. The Session Context swap and the
	 * compaction entry it produces are published by the command, before its
	 * promise settles, so a caller that joins it reads a settled context.
	 */
	const startCompaction = (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const controller = new AbortController();
		const registration = Promise.withResolvers<void>();
		const { promise, reject, resolve } =
			Promise.withResolvers<CompactSessionResult>();
		compactionCommand = {
			abort: () => controller.abort(),
			promise,
			registered: registration.promise,
		};
		setCompacting(true);
		void (async () => {
			try {
				const request = await compactionRequest(
					command,
					messages,
					controller.signal
				);
				// Admission happens when the module is entered, so a request that
				// arrives while this one resolves its settings still joins it.
				const admitted = ports.compaction.compact(request);
				registration.resolve();
				const result = await admitted;
				applyContext(result.activeMessages);
				recordCompaction(result.entry);
				setCompactionError(null);
				resolve(result);
			} catch (error) {
				registration.resolve();
				reject(error);
			} finally {
				if (compactionCommand?.promise === promise) {
					compactionCommand = undefined;
					setCompacting(false);
				}
				// A submission that arrived while this compaction held the lane
				// runs as soon as it no longer does.
				void drainQueuedSubmissions();
			}
		})();
		return promise;
	};
	/**
	 * Joins the command in flight. A request that carries its intent is answered
	 * by that command; one that carries another intent is refused, so a caller is
	 * never answered with another caller's entry. A joined request's messages
	 * never travel — the command it joins owns the swap — so the Session
	 * Transcript is the source it names.
	 */
	const joinCompaction = async (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[]
	): Promise<CompactSessionResult> => {
		const owner = compactionCommand;
		// The command this one joins may still be resolving its settings, and the
		// module only knows a request it has been entered with: wait for that
		// admission before asking it to join, so its decision is about a request
		// it can already see.
		if (!isUndefined(owner)) {
			await owner.registered;
		}
		if (isShutDown) {
			throw new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR);
		}
		const request = await compactionRequest(
			command,
			messages,
			new AbortController().signal
		);
		if (isShutDown) {
			throw new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR);
		}
		const result = await ports.compaction.compact(request);
		if (!isUndefined(owner)) {
			await owner.promise;
		}
		return result;
	};
	const trackPendingCompaction = (
		result: Promise<CompactSessionResult>
	): Promise<CompactSessionResult> => {
		pendingCompactions.add(result);
		void (async () => {
			try {
				await result;
			} catch {
				// The compaction caller observes the original rejection.
			} finally {
				pendingCompactions.delete(result);
			}
		})();
		return result;
	};
	const compact = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		if (isShutDown) {
			return Promise.reject(
				new SessionCompactionError("cancelled", SHUT_DOWN_SEND_ERROR)
			);
		}
		const messages = compactionSource(command);
		// The Engine's own command is checked first: a request that arrives while
		// that command still resolves its settings joins it rather than starting
		// a second command the module would only refuse.
		const running =
			compactionCommand ?? ports.compaction.getInFlight(sessionId);
		const result = isNull(running)
			? startCompaction(command, messages)
			: joinCompaction(command, messages);
		return trackPendingCompaction(result);
	};
	const settleCompaction = async (): Promise<Error | null> => {
		// A command that starts while this waits is joined too, so a caller that
		// continues afterwards reads a context no compaction is about to replace.
		while (true) {
			const command = compactionCommand;
			if (isUndefined(command)) {
				return null;
			}
			try {
				await command.promise;
			} catch (error) {
				return isError(error) ? error : new Error("Session compaction failed.");
			}
		}
	};
	/**
	 * Resolves once the Agent Turn that proposed a recovery has ended; an
	 * execution that is not live has already ended.
	 */
	const waitForExecutionEnd = (turnId: AgentTurnId): Promise<void> => {
		if (!state.executions.some((execution) => execution.turnId === turnId)) {
			return Promise.resolve();
		}
		const { promise, resolve } = Promise.withResolvers<void>();
		const waiters = executionEndWaiters.get(turnId);
		if (isUndefined(waiters)) {
			executionEndWaiters.set(turnId, [resolve]);
		} else {
			waiters.push(resolve);
		}
		return promise;
	};
	/** One recovery failure with the compaction error code it publishes. */
	const recoveryError = (
		message: string,
		cause: unknown
	): OverflowRecoveryError =>
		new OverflowRecoveryError("replay-failed", message, { cause });
	/**
	 * Publishes one recovery failure as the compaction error and reports it, so
	 * a caller that proposed the recovery has nothing left to continue.
	 */
	const failRecovery = (
		error: OverflowRecoveryError
	): SessionOverflowRecoveryOutcome => {
		setCompactionError(error);
		return { kind: "failed", error };
	};
	/**
	 * Runs one recovery: it records the attempt against the user message the
	 * failed turn answers, compacts the replay-safe history through the Engine's
	 * own compaction command — so the Session Context swap and the entry are
	 * published exactly as for any other compaction — and then replays that
	 * message. A recovery the session refuses or that fails is published as the
	 * compaction error instead of being continued by its caller.
	 */
	const runOverflowRecovery = async (
		command: SessionOverflowRecoveryCommand
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (!isContextOverflowFailure(command.error)) {
			return { kind: "ineligible" };
		}
		// Recorded before anything is awaited, so the attempt covers the whole
		// recovery: a refusal that arrives while this one is under way is refused
		// as exhausted rather than starting a second compaction, and no send or
		// command can reset it.
		if (recoveryAttempts.has(command.originalMessageId)) {
			return { kind: "exhausted" };
		}
		recoveryAttempts.add(command.originalMessageId);
		let target: SessionOverflowRecoveryTarget | null;
		try {
			target = await command.resolveTarget();
		} catch (error) {
			return failRecovery(
				recoveryError(
					"Context overflow recovery could not resolve its compaction settings.",
					error
				)
			);
		}
		if (isNull(target)) {
			// Nothing was tried, so the message keeps its one attempt.
			recoveryAttempts.delete(command.originalMessageId);
			return { kind: "ineligible" };
		}
		let result: CompactSessionResult;
		try {
			result = await compact({
				model: target.model,
				sourceMessages: prepareOverflowReplayMessages(
					state.transcript,
					command.originalMessageId
				),
				trigger: "overflow",
				...omitUndefined({ variant: target.variant }),
			});
		} catch (error) {
			return failRecovery(
				error instanceof OverflowRecoveryError
					? error
					: recoveryError(
							`Context overflow recovery could not compact the session.${getErrorMessage(error, "")}`,
							error
						)
			);
		}
		// The replay waits for the failed execution so it cannot overlap its
		// interrupted turn.
		await waitForExecutionEnd(command.turnId);
		// Shutdown can race the recovery's execution-end wake-up. The replay is
		// fenced again here because its callback bypasses the public send entrypoint.
		if (isShutDown) {
			return { kind: "ineligible" };
		}
		let replayOutcome: SessionOverflowReplayOutcome;
		try {
			replayOutcome = await command.replay({
				originalMessageId: command.originalMessageId,
			});
		} catch (error) {
			return failRecovery(
				recoveryError(
					"Context overflow recovery could not replay the original user message.",
					error
				)
			);
		}
		if (replayOutcome.kind === "refused") {
			return failRecovery(
				new OverflowRecoveryError(
					"replay-refused",
					`Context overflow recovery could not replay the original user message: ${replayOutcome.reason}`,
					{ cause: command.error }
				)
			);
		}
		return { kind: "recovered", entry: result.entry };
	};
	const recoverOverflow = (
		command: SessionOverflowRecoveryCommand
	): Promise<SessionOverflowRecoveryOutcome> => {
		if (isShutDown) {
			return Promise.resolve({ kind: "ineligible" });
		}
		return runOverflowRecovery(command);
	};

	/** Drops an execution and wakes everything waiting for it to end. */
	const endExecution = (turnId: AgentTurnId): void => {
		const waiters = executionEndWaiters.get(turnId);
		if (!isUndefined(waiters)) {
			executionEndWaiters.delete(turnId);
			for (const resolveEnd of waiters) {
				resolveEnd();
			}
		}
		const executions = state.executions.filter(
			(execution) => execution.turnId !== turnId
		);
		if (executions.length === state.executions.length) {
			return;
		}
		publish({ executions, viewState: exposedViewState(executions) });
	};
	const setTurnActive = (value: boolean): void =>
		publish({ turnActive: value });

	const beginExecution = (input: SessionExecutionInput): SessionExecution => {
		const turnId = input.turnId ?? createAgentTurnId();
		const execution: SessionExecution = {
			agent: input.agent,
			assistantId: toSessionMessageId(`assistant-${turnId}`),
			model: input.model,
			...omitUndefined({
				parent: input.parent,
				sessionVariant: input.sessionVariant,
				variant: input.variant,
			}),
			sessionModel: input.sessionModel,
			sourceUserMessageId: input.sourceUserMessageId ?? null,
			startedAt: input.startedAt,
			turnId,
		};
		publish({ executions: [...state.executions, execution] });
		return execution;
	};
	const setExecutionViewState = (
		turnId: AgentTurnId,
		viewState: SessionViewState
	): void => {
		if (!state.executions.some((execution) => execution.turnId === turnId)) {
			return;
		}
		const executions = state.executions.map((execution) =>
			execution.turnId === turnId ? { ...execution, viewState } : execution
		);
		publish({ executions, viewState: exposedViewState(executions) });
	};
	/**
	 * The Agent Turn execution the session's own sends run as: the newest
	 * execution that is not a delegated Subagent, so an interrupt reaches the
	 * turn the user started rather than a child it spawned.
	 */
	const primaryExecution = (): SessionExecution | undefined =>
		primaryEntry(state.executions);
	/**
	 * Presents an interrupted turn: the target message keeps the interrupted
	 * Tool Call the abort named and the context is sanitized around it.
	 */
	const interruptLatestAssistantMessage = (
		preserveToolCallId?: ToolCallId
	): void => {
		const next = interruptSessionContext(
			state.context,
			primaryExecution(),
			preserveToolCallId
		);
		if (isUndefined(next)) {
			return;
		}
		applyContext(next);
		mergeTranscript(next);
	};

	/**
	 * Delivers the Steering Lane into the running Agent Turn: the lane is
	 * popped and every message becomes a Session Record at this moment, so the
	 * delivery point and the commit point are the same event. The message joins
	 * the Session Context and the Session Transcript, and its metadata names
	 * the Agent Turn it joined rather than moving the anchor Overflow Recovery
	 * and retry walk.
	 */
	const takeSteeringMessages = (
		execution: SessionExecution
	): SessionMessage[] => {
		if (!isUndefined(execution.parent) || state.steeringMessages.length === 0) {
			return [];
		}
		const taken = state.steeringMessages;
		publish({ steeringMessages: [] });
		// The message joins the turn it was sent to, so it records the Agent and
		// Model Target that turn is already running with: a correction made
		// mid-turn cannot switch a model under the user.
		const delivered = taken.map(({ input }) =>
			createSessionUserMessage(input.text, {
				agent: execution.agent,
				joinedTurnId: execution.turnId,
				model: execution.model,
				...omitUndefined({ variant: execution.variant }),
			})
		);
		applyContext([...state.context, ...delivered]);
		mergeTranscript(delivered);
		for (const message of delivered) {
			commitSteeringRecord(execution, message);
		}
		return delivered;
	};
	/**
	 * Writes the Session Record of one delivered Steering Message. The write is
	 * started at the delivery point and its failure is published, so a durable
	 * commit that cannot land never rolls the delivered message back out of the
	 * turn it already joined.
	 */
	const commitSteeringRecord = (
		execution: SessionExecution,
		message: SessionMessage
	): void => {
		const write = ports
			.commitRecord({
				record: buildUserSessionRecord({
					agentId: execution.agent,
					message,
					model: execution.model,
					turnId: execution.turnId,
					...omitUndefined({ variant: execution.variant }),
				}),
				sessionId,
				sessionModel: execution.sessionModel,
				...omitUndefined({ sessionVariant: execution.sessionVariant }),
			})
			.catch((error: unknown) => {
				publish({
					error: isError(error)
						? error
						: new Error("Could not save the Steering Message."),
				});
			});
		pendingDurableWrites.add(write);
		void write.then(
			() => pendingDurableWrites.delete(write),
			() => pendingDurableWrites.delete(write)
		);
	};
	const waitForDurableWrites = async (): Promise<void> => {
		while (pendingDurableWrites.size > 0) {
			await Promise.all([...pendingDurableWrites]);
		}
	};
	const waitForCompactions = async (): Promise<void> => {
		while (pendingCompactions.size > 0) {
			await Promise.all([...pendingCompactions]);
		}
	};
	/**
	 * Hands anything still waiting in the Steering Lane to the Submission
	 * Queue when its Agent Turn ends without delivering it — a tool-less turn
	 * runs exactly one Model Step and has no boundary to deliver at. Acceptance
	 * order is kept, so nothing is silently dropped and every message runs as
	 * its own Agent Turn.
	 */
	const fallbackSteeringMessages = (): void => {
		if (state.steeringMessages.length === 0) {
			return;
		}
		const waiting: SessionQueuedSubmission[] = state.steeringMessages.map(
			({ input }) => ({
				id: toQueuedSubmissionId(crypto.randomUUID()),
				input: {
					agent: input.agent,
					composition: input.composition,
					files: input.composition.files,
					model: input.model,
					sessionModel: input.sessionModel,
					userText: input.text,
					...omitUndefined({
						resolvedAgent: input.resolvedAgent,
						sessionVariant: input.sessionVariant,
						variant: input.variant,
					}),
				},
			})
		);
		publish({
			queuedSubmissions: [...state.queuedSubmissions, ...waiting],
			steeringMessages: [],
		});
	};

	let pipeline: SubmissionPipeline;
	const operation = createSessionOperation({
		deadlineMs: AGENT_TURN_DEADLINE_MS,
		execute: async (input, signal) => {
			if (signal.aborted) {
				return sessionSendCancelled(signal);
			}
			const stop = (): void => {
				compactionCommand?.abort();
				closeApprovals();
			};
			signal.addEventListener("abort", stop, { once: true });
			try {
				return await pipeline.send(input, signal);
			} catch (error) {
				// A submission that throws still publishes its failure, and the
				// caller that awaited the send is the one that answers it.
				publish({
					error: isError(error) ? error : new Error("Session failed."),
				});
				throw error;
			} finally {
				signal.removeEventListener("abort", stop);
			}
		},
		onInterrupt: interruptLatestAssistantMessage,
	});
	pipeline = createSubmissionPipeline({
		applyContext,
		beginExecution,
		compact,
		endExecution,
		fallbackSteeringMessages,
		getContext: () => state.context,
		getTranscript: () => state.transcript,
		mergeTranscript,
		ports,
		recoverOverflow,
		send: (input) =>
			isShutDown
				? Promise.resolve({
						rejected: true,
						reason: SHUT_DOWN_SEND_ERROR,
					})
				: runSubmission(input),
		sessionId,
		setCatalogDiagnostic: (diagnostic) =>
			publish({ catalogDiagnostic: diagnostic }),
		setCompactionError,
		setError: (error) => publish({ error }),
		setExecutionViewState,
		setTurnActive,
		settleCompaction,
		takeSteeringMessages,
	});

	/**
	 * Runs one submission on the send lane, then keeps the queue moving: a run
	 * that ends is not the last work here, and whatever queued behind it starts
	 * now. Every lane run goes through here — the session's own sends, and the
	 * overflow replay a recovery continues — so the Submission Queue is never
	 * drained onto a lane that is still taken.
	 */
	const runSubmission = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		laneRuns += 1;
		try {
			return await operation.send(input);
		} finally {
			laneRuns -= 1;
			void drainQueuedSubmissions();
		}
	};
	/** Releases the blobs of compositions nothing holds any more. */
	const releaseQueuedAttachments = (
		submissions: readonly SessionQueuedSubmission[]
	): void => {
		const attachmentIds = submissions.flatMap(({ input }) =>
			queuedAttachmentIds(input)
		);
		if (attachmentIds.length > 0) {
			ports.attachments.release(attachmentIds);
		}
	};
	/**
	 * Stores a composition's attachments, so a queued wait cannot outlive the
	 * blobs it still shows.
	 */
	const storeCompositionFiles = async (
		files: readonly SessionFilePart[]
	): Promise<SessionFilePart[]> => {
		if (files.every((file) => !isUndefined(file.attachmentId))) {
			return [...files];
		}
		const [stored] = await ports.attachments.externalize(
			[createSessionUserMessage("", undefined, [], [...files])],
			new AbortController().signal
		);
		return (stored?.parts ?? []).filter(
			(part): part is SessionFilePart => part.type === "file"
		);
	};
	/**
	 * Runs queued submissions one Agent Turn at a time, oldest first, until the
	 * queue is empty. It never overlaps the lane: while a submission run holds
	 * it, while a turn is live, or while the queue is already being walked, this
	 * does nothing, and the run that ends continues the walk through its own
	 * release. A compaction in flight holds the queue too, so a waiting
	 * submission stays visible in the Submission Queue until the compaction it
	 * would join has landed.
	 */
	const drainQueuedSubmissions = async (): Promise<void> => {
		if (
			draining ||
			isShutDown ||
			laneRuns > 0 ||
			state.turnActive ||
			state.isCompacting
		) {
			return;
		}
		draining = true;
		try {
			while (!isShutDown) {
				const next = state.queuedSubmissions[0];
				if (isUndefined(next)) {
					break;
				}
				// The item stops waiting before it runs: it is no longer
				// something a Recall can withdraw, and its Agent Turn is what
				// commits it to the Session Transcript.
				publish({ queuedSubmissions: state.queuedSubmissions.slice(1) });
				try {
					await runSubmission(next.input);
				} catch {
					// The submission published its own failure, and a failed
					// turn never strands the submissions behind it.
				}
				// The Session Records this run committed name these blobs now.
				releaseQueuedAttachments([next]);
			}
		} finally {
			draining = false;
		}
	};
	/**
	 * Accepts one submission into the Submission Queue: it stores the
	 * composition's attachments and keeps their blobs alive for as long as the
	 * item waits, so a slow Agent Turn can neither break nor run it.
	 */
	const acceptQueuedSubmission = async (
		input: SessionSendInput
	): Promise<SessionSendOutcome> => {
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: input.files ?? [],
			text: input.userText ?? "",
		};
		let files: SessionFilePart[];
		try {
			files = await storeCompositionFiles(composition.files);
		} catch {
			return { rejected: true, reason: QUEUED_ATTACHMENT_ERROR };
		}
		if (isShutDown) {
			return { rejected: true, reason: SHUT_DOWN_SEND_ERROR };
		}
		const stored: SessionSubmissionComposition = { ...composition, files };
		const queuedInput: SessionQueuedSendInput = {
			...input,
			composition: stored,
			files,
		};
		const queued: SessionQueuedSubmission = {
			id: toQueuedSubmissionId(crypto.randomUUID()),
			input: queuedInput,
		};
		publish({ queuedSubmissions: [...state.queuedSubmissions, queued] });
		ports.attachments.retain(queuedAttachmentIds(queuedInput));
		// Storing the composition can outlast the work that was in flight, so
		// the queue is walked again here; a busy lane makes that a no-op.
		void drainQueuedSubmissions();
		return { rejected: false };
	};
	/**
	 * Accepts one submission into the Steering Lane of the running Agent Turn:
	 * a Steering Message carries text only, so nothing is materialised and
	 * nothing is hydrated — it waits exactly as it was composed and travels at
	 * the next Model Step boundary.
	 */
	const acceptSteeringMessage = (
		input: SessionSendInput
	): SessionSendOutcome => {
		const composition: SessionSubmissionComposition = input.composition ?? {
			files: [],
			text: input.userText ?? "",
		};
		if ((input.files ?? composition.files).length > 0) {
			return { rejected: true, reason: STEERING_ATTACHMENT_ERROR };
		}
		if (!isUndefined(input.skill)) {
			return { rejected: true, reason: STEERING_SKILL_ERROR };
		}
		if (!(isUndefined(input.messageId) && isUndefined(input.delegation))) {
			return { rejected: true, reason: STEERING_INVOCATION_ERROR };
		}
		const steering: SessionSteeringMessage = {
			id: toSteeringMessageId(crypto.randomUUID()),
			input: {
				agent: input.agent,
				// The message carries text only, so its composition travels back
				// to the composer exactly as it was composed.
				composition: { ...composition, files: [] },
				model: input.model,
				sessionModel: input.sessionModel,
				text: input.userText ?? composition.text,
				...omitUndefined({
					resolvedAgent: input.resolvedAgent,
					sessionVariant: input.sessionVariant,
					variant: input.variant,
				}),
			},
		};
		publish({ steeringMessages: [...state.steeringMessages, steering] });
		return { rejected: false };
	};
	const recallWaitingMessages = (
		ids?: readonly SessionWaitingMessageId[]
	): SessionWaitingMessage[] => {
		const steering = isUndefined(ids)
			? [...state.steeringMessages]
			: state.steeringMessages.filter(({ id }) => ids.includes(id));
		const queued = isUndefined(ids)
			? [...state.queuedSubmissions]
			: state.queuedSubmissions.filter(({ id }) => ids.includes(id));
		if (steering.length === 0 && queued.length === 0) {
			return [];
		}
		publish({
			queuedSubmissions: state.queuedSubmissions.filter(
				(submission) => !queued.includes(submission)
			),
			steeringMessages: state.steeringMessages.filter(
				(message) => !steering.includes(message)
			),
		});
		releaseQueuedAttachments(queued);
		return [...steering, ...queued];
	};
	/**
	 * Whether a submission is held instead of run now: the lane is taken, the
	 * queue is already being walked, work the next submission would wait for is
	 * in flight, or waiting submissions are already here.
	 */
	const queuesSubmission = (): boolean =>
		laneRuns > 0 ||
		draining ||
		state.turnActive ||
		state.isCompacting ||
		state.queuedSubmissions.length > 0;
	/**
	 * The Engine's one send entry point. A submission that arrives while an
	 * Agent Turn is running joins that turn's Steering Lane and is delivered
	 * inside it; while the session is busy any other way it joins the
	 * Submission Queue and runs as its own Agent Turn; an idle session runs it
	 * on the lane and then keeps the queue moving.
	 */
	const send = async (input: SessionSendInput): Promise<SessionSendOutcome> => {
		if (isShutDown) {
			return { rejected: true, reason: SHUT_DOWN_SEND_ERROR };
		}
		if (acceptsSteeringMessages(state)) {
			return acceptSteeringMessage(input);
		}
		if (queuesSubmission()) {
			return await acceptQueuedSubmission(input);
		}
		return await runSubmission(input);
	};
	const hasPendingWork = (): boolean =>
		laneRuns > 0 ||
		draining ||
		compactionCommand !== undefined ||
		pendingCompactions.size > 0 ||
		pendingApprovals.size > 0 ||
		pendingDurableWrites.size > 0 ||
		state.turnActive ||
		state.isCompacting ||
		state.executions.length > 0;
	const shutdown = (): Promise<void> => {
		if (shutdownPromise !== undefined) {
			return shutdownPromise;
		}
		isShutDown = true;
		// Whatever was waiting is dropped with the session: its attachment
		// holds end and nothing it held is ever run.
		recallWaitingMessages();
		operation.cancel();
		closeApprovals();
		const compaction = compactionCommand?.promise;
		shutdownPromise = (async () => {
			const operationIdle = operation.waitForIdle();
			const compactionSettled = (async (): Promise<void> => {
				if (compaction === undefined) {
					return;
				}
				try {
					await compaction;
				} catch {
					// A shutdown-triggered compaction cancellation is expected.
				}
			})();
			await operationIdle;
			await compactionSettled;
			await waitForCompactions();
			await waitForDurableWrites();
		})();
		return shutdownPromise;
	};

	return {
		abortApprovalTurn: (toolCallId) => {
			// The aborted request already settled in the Engine, so its siblings
			// are closed as rejects and the turn stops exactly once: a second
			// abort trigger finds nothing pending to handle.
			closeApprovals();
			interruptLatestAssistantMessage(toolCallId);
		},
		applyContext,
		beginExecution,
		cancel: () => operation.cancel(),
		cancelCompaction: () => {
			compactionCommand?.abort();
			return recallWaitingMessages();
		},
		closeApprovals,
		compact,
		hasPendingWork,
		endExecution,
		getSnapshot: () => state,
		interrupt: (preserveToolCallId) => {
			operation.interrupt(preserveToolCallId);
			return recallWaitingMessages();
		},
		mergeTranscript,
		recallWaitingMessages,
		recoverOverflow,
		requestApproval,
		respondToApproval: settleApproval,
		setExecutionViewState,
		settleCompaction,
		shutdown,
		send,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
