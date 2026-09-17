import { isError, isNull, isUndefined } from "@wincode/runtime-utils";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionInput,
	CompactSessionResult,
} from "../compaction/compaction";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
import type { SessionMessage } from "../message";
import type {
	SessionApprovalOutcome,
	SessionCompactionCommand,
	SessionEngine,
	SessionEngineOptions,
	SessionSnapshot,
} from "./types";
import { exposedViewState, hasChanged } from "./utils";

/**
 * The single owner of one session's live state and the only writer to it.
 * Observers read a Session Snapshot and never write; the engine replaces the
 * snapshot instead of mutating it.
 */
export const createSessionEngine = ({
	compaction,
	initialCompactions = [],
	initialContext,
	initialTranscript,
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
		isPreparingMessage: false,
		status: "ready",
		transcript: [...initialTranscript],
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
	const compactionRequest = (
		command: SessionCompactionCommand,
		messages: readonly SessionMessage[],
		signal?: AbortSignal
	): CompactSessionInput => ({
		model: command.model,
		session: { messages, sessionId },
		settings: command.settings,
		trigger: command.trigger,
		...(isUndefined(command.focus) ? {} : { focus: command.focus }),
		...(isUndefined(signal) ? {} : { signal }),
		...(isUndefined(command.variant) ? {} : { variant: command.variant }),
	});
	/**
	 * Runs a command the module admitted. The Session Context swap and the
	 * compaction entry it produces are published by the command, before its
	 * promise settles, so a caller that joins it reads a settled context.
	 */
	const startCompaction = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		const controller = new AbortController();
		const request = compactionRequest(
			command,
			compactionSource(command),
			controller.signal
		);
		const { promise, reject, resolve } =
			Promise.withResolvers<CompactSessionResult>();
		compactionCommand = { abort: () => controller.abort(), promise };
		setCompacting(true);
		void (async () => {
			try {
				const result = await compaction.compact(request);
				applyContext(result.activeMessages);
				recordCompaction(result.entry);
				setCompactionError(null);
				resolve(result);
			} catch (error) {
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
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		const owner = compactionCommand;
		const result = await compaction.compact(
			compactionRequest(command, state.transcript)
		);
		if (!isUndefined(owner)) {
			await owner.promise;
		}
		return result;
	};
	const compact = (
		command: SessionCompactionCommand
	): Promise<CompactSessionResult> => {
		const running = compaction.getInFlight(sessionId);
		return isNull(running) ? startCompaction(command) : joinCompaction(command);
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

	return {
		applyContext,
		beginExecution: ({ parent, startedAt, turnId }) =>
			publish({
				executions: [
					...state.executions,
					{
						...(isUndefined(parent) ? {} : { parent }),
						startedAt,
						turnId,
					},
				],
			}),
		cancelCompaction: () => compactionCommand?.abort(),
		closeApprovals,
		compact,
		endExecution: (turnId) => {
			const executions = state.executions.filter(
				(execution) => execution.turnId !== turnId
			);
			if (executions.length === state.executions.length) {
				return;
			}
			publish({ executions, viewState: exposedViewState(executions) });
		},
		getSnapshot: () => state,
		mergeTranscript,
		requestApproval,
		respondToApproval: settleApproval,
		setCatalogDiagnostic: (diagnostic) =>
			publish({ catalogDiagnostic: diagnostic }),
		setCompactionError,
		setError: (error) => publish({ error }),
		setExecutionViewState: (turnId, viewState) => {
			if (!state.executions.some((execution) => execution.turnId === turnId)) {
				return;
			}
			const executions = state.executions.map((execution) =>
				execution.turnId === turnId ? { ...execution, viewState } : execution
			);
			publish({ executions, viewState: exposedViewState(executions) });
		},
		setPreparingMessage: (value) => publish({ isPreparingMessage: value }),
		setStatus: (status) => publish({ status }),
		settleCompaction,
		shutdown: () => {
			isShutDown = true;
			closeApprovals();
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
