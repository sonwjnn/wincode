import type {
	AgentTurn,
	AgentTurnEvent,
	AgentTurnId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { isError, isNull, isUndefined } from "@wincode/runtime-utils";
import type { ReadonlyDeep } from "type-fest";
import type { SessionId } from "@/shared/identifiers";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionInput,
	CompactSessionResult,
	SessionCompactionModule,
} from "../compaction/compaction";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type {
	CompactionTriggerReason,
	SessionCompaction,
} from "../compaction/types";
import type { SessionMessage } from "../message";

export type SessionChatStatus = "ready" | "streaming" | "submitted";

/**
 * The live projection of one Agent Turn execution for the session UI. It is
 * transient and never becomes a Session Record.
 */
export type SessionViewState = ReadonlyDeep<{
	delegation?: AgentTurn["delegation"];
	lastEventType?: AgentTurnEvent["type"];
	lastSequence: number;
	reasoningText: string;
	status: "idle" | "streaming" | "terminal";
	text: string;
	turnId: AgentTurnId;
}>;

/**
 * One live Agent Turn execution the Engine tracks, oldest first. Its view
 * state belongs to that execution alone, so a delegated Subagent never
 * replaces the view of the execution that spawned it.
 */
export type SessionExecution = ReadonlyDeep<{
	/** Set for a delegated Subagent execution: the turn and Tool Call it came from. */
	parent?: AgentTurn["delegation"];
	startedAt: number;
	turnId: AgentTurnId;
	viewState?: SessionViewState;
}>;

/** One settlement decision for an approval request. */
export type SessionApprovalOutcome =
	| { decision: "abort" }
	| { decision: "allow"; remember: boolean }
	| { decision: "reject"; feedback?: string };

/**
 * One approval request the Engine owns until it settles. `target` is
 * `tool-call` when the request carries a Tool Call Identifier and `session`
 * when it has no timeline anchor of its own. A request with no `decision` is
 * pending; a settled request is never settled again.
 */
export type SessionApproval = ReadonlyDeep<{
	decision?: SessionApprovalOutcome;
	id: string;
	request: ToolApprovalRequest;
	target: "session" | "tool-call";
}>;

/** The session facts an observer reads at one moment. */
export type SessionSnapshot = ReadonlyDeep<{
	/** Approval requests the Engine owns, oldest first, settled ones included. */
	approvals: SessionApproval[];
	catalogDiagnostic: string | null;
	compactions: SessionCompaction[];
	compactionError: Error | null;
	/** Session Context: the messages the next Agent Turn sends to the model. */
	context: SessionMessage[];
	error: Error | null;
	/** Live Agent Turn executions, oldest first. */
	executions: SessionExecution[];
	isCompacting: boolean;
	isPreparingMessage: boolean;
	status: SessionChatStatus;
	/** Session Transcript: the messages the session presents to the user. */
	transcript: SessionMessage[];
	/**
	 * The live view of the most recently active execution, so the parent's view
	 * returns when a delegated Subagent ends.
	 */
	viewState: SessionViewState | undefined;
}>;

export type SessionExecutionInput = ReadonlyDeep<{
	parent?: AgentTurn["delegation"];
	startedAt: number;
	turnId: AgentTurnId;
}>;

/**
 * The Session Compaction module the Engine submits compaction commands to. Its
 * per-session in-flight map owns the admission decision: a request either runs,
 * joins one that carries the same intent, or is refused.
 */
export type SessionCompactionPort = Pick<
	SessionCompactionModule,
	"compact" | "getInFlight"
>;

/** One compaction request as the Session Command the Engine runs. */
export type SessionCompactionCommand = ReadonlyDeep<{
	focus?: string;
	model: ChatModelSelection;
	/** Merged into the Session Transcript before compacting, when supplied. */
	nextMessages?: readonly SessionMessage[];
	settings: CompactSessionInput["settings"];
	/** Compacted in place of the Session Transcript, when supplied. */
	sourceMessages?: readonly SessionMessage[];
	trigger: CompactionTriggerReason;
	variant?: ModelVariant;
}>;

export type SessionEngineOptions = ReadonlyDeep<{
	compaction: SessionCompactionPort;
	initialCompactions?: readonly SessionCompaction[];
	initialContext?: readonly SessionMessage[];
	initialTranscript: readonly SessionMessage[];
	sessionId: SessionId;
}>;

export type SessionEngine = Readonly<{
	/** Replaces the Session Context. */
	applyContext: (messages: readonly SessionMessage[]) => void;
	/** Registers a starting Agent Turn execution and its parent linkage. */
	beginExecution: (execution: SessionExecutionInput) => void;
	/** Aborts the compaction command in flight. */
	cancelCompaction: () => void;
	/**
	 * Settles every pending approval as rejected, so no Tool Gate evaluation
	 * that asked for one is left waiting. The newest pending request carries the
	 * feedback.
	 */
	closeApprovals: (feedback?: string) => void;
	/**
	 * Runs a compaction command. A command whose intent is already in flight
	 * joins it; one that carries another intent is refused, so no caller is
	 * answered with another caller's entry.
	 */
	compact: (command: SessionCompactionCommand) => Promise<CompactSessionResult>;
	/** Drops an execution and everything that belonged to it. */
	endExecution: (turnId: AgentTurnId) => void;
	getSnapshot: () => SessionSnapshot;
	/**
	 * Merges messages into the Session Transcript: an existing message is
	 * replaced by id, an unknown one is appended, and a compaction summary
	 * never enters the Transcript.
	 */
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	/**
	 * Registers an approval request for the session's single settlement path.
	 * The returned promise resolves once, when the request is settled by a panel
	 * action, the close-approvals command, an abort, or shutdown.
	 */
	requestApproval: (
		request: ToolApprovalRequest
	) => Promise<SessionApprovalOutcome>;
	/** Settles one pending approval; an already settled request is left alone. */
	respondToApproval: (id: string, outcome: SessionApprovalOutcome) => void;
	setCatalogDiagnostic: (diagnostic: string | null) => void;
	setCompactionError: (error: Error | null) => void;
	setError: (error: Error | null) => void;
	/** Replaces one execution's Session View State, never another's. */
	setExecutionViewState: (
		turnId: AgentTurnId,
		viewState: SessionViewState
	) => void;
	setPreparingMessage: (value: boolean) => void;
	setStatus: (status: SessionChatStatus) => void;
	/**
	 * Waits until no compaction command is in flight, so the Session Context a
	 * caller reads next is the settled one. Reports the failure that ended the
	 * wait, when a command ends with one.
	 */
	settleCompaction: () => Promise<Error | null>;
	/**
	 * Ends the session: settles every pending approval through the same path and
	 * refuses later requests, so nothing stays waiting on a session that is gone.
	 */
	shutdown: () => void;
	subscribe: (listener: () => void) => () => void;
}>;

const hasChanged = (
	state: SessionSnapshot,
	changes: Partial<SessionSnapshot>
): boolean =>
	(Object.keys(changes) as (keyof SessionSnapshot)[]).some(
		(key) => !Object.is(state[key], changes[key])
	);

/** The newest live execution that has streamed is the view the session shows. */
const exposedViewState = (
	executions: readonly SessionExecution[]
): SessionViewState | undefined => {
	for (let index = executions.length - 1; index >= 0; index -= 1) {
		const viewState = executions[index]?.viewState;
		if (!isUndefined(viewState)) {
			return viewState;
		}
	}
	return;
};

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
