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
} from "@wincode/runtime-utils";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionInput,
	CompactSessionResult,
} from "../compaction/compaction";
import {
	isContextOverflowFailure,
	OverflowRecoveryError,
	prepareOverflowReplayMessages,
} from "../compaction/overflow-recovery";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import type { SessionMessage } from "../message";
import { createSessionOperation } from "../session-operation";
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
	SessionSnapshot,
	SessionViewState,
} from "./types";
import { exposedViewState, hasChanged, primaryEntry } from "./utils";

/** The deadline one Agent Turn submission runs with. */
const AGENT_TURN_DEADLINE_MS = 43_200_000;

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
		...(isUndefined(command.focus) ? {} : { focus: command.focus }),
		signal,
		...(isUndefined(command.variant) ? {} : { variant: command.variant }),
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
		const result = await ports.compaction.compact(
			await compactionRequest(command, messages, new AbortController().signal)
		);
		if (!isUndefined(owner)) {
			await owner.promise;
		}
		return result;
	};
	const compact = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		const messages = compactionSource(command);
		// The Engine's own command is checked first: a request that arrives while
		// that command still resolves its settings joins it rather than starting a
		// second command the module would only refuse.
		const running =
			compactionCommand ?? ports.compaction.getInFlight(sessionId);
		return isNull(running)
			? startCompaction(command, messages)
			: joinCompaction(command, messages);
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
	const recoverOverflow = async (
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
				...(isUndefined(target.variant) ? {} : { variant: target.variant }),
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
		// The replay never runs while the turn that proposed the recovery is
		// still live, and a replay the session refuses is reported, never queued
		// behind or overlapped with a send that is already running.
		await waitForExecutionEnd(command.turnId);
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
			...(isUndefined(input.parent) ? {} : { parent: input.parent }),
			sessionModel: input.sessionModel,
			...(isUndefined(input.sessionVariant)
				? {}
				: { sessionVariant: input.sessionVariant }),
			sourceUserMessageId: input.sourceUserMessageId ?? null,
			startedAt: input.startedAt,
			turnId,
			...(isUndefined(input.variant) ? {} : { variant: input.variant }),
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

	const cancelCompaction = (): void => compactionCommand?.abort();
	let pipeline: SubmissionPipeline;
	const operation = createSessionOperation({
		deadlineMs: AGENT_TURN_DEADLINE_MS,
		execute: async (input, signal) => {
			if (signal.aborted) {
				return sessionSendCancelled(signal);
			}
			const stop = (): void => {
				cancelCompaction();
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
		getContext: () => state.context,
		getTranscript: () => state.transcript,
		mergeTranscript,
		ports,
		recoverOverflow,
		send: (input) => operation.send(input),
		sessionId,
		setCatalogDiagnostic: (diagnostic) =>
			publish({ catalogDiagnostic: diagnostic }),
		setCompactionError,
		setError: (error) => publish({ error }),
		setExecutionViewState,
		setTurnActive,
		settleCompaction,
	});

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
		cancelCompaction,
		closeApprovals,
		compact,
		endExecution,
		getSnapshot: () => state,
		interrupt: (preserveToolCallId) => operation.interrupt(preserveToolCallId),
		mergeTranscript,
		recoverOverflow,
		requestApproval,
		respondToApproval: settleApproval,
		setExecutionViewState,
		settleCompaction,
		shutdown: () => {
			isShutDown = true;
			operation.cancel();
			closeApprovals();
		},
		send: (input) => operation.send(input),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
