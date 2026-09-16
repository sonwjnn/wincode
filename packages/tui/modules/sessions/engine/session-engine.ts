import type {
	AgentTurn,
	AgentTurnEvent,
	AgentTurnId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import { isError, isNull, isUndefined } from "@wincode/runtime-utils";
import type { ReadonlyDeep } from "type-fest";
import type { SessionId } from "@/shared/identifiers";
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

/** The session facts an observer reads at one moment. */
export type SessionSnapshot = ReadonlyDeep<{
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
		for (;;) {
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
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
