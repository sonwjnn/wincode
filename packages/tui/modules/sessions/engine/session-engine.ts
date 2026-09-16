import type {
	AgentTurn,
	AgentTurnEvent,
	AgentTurnId,
} from "@wincode/agent-core";
import type { ReadonlyDeep } from "type-fest";
import { isCompactionSummaryMessage } from "../compaction/summary-message";
import type { SessionCompaction } from "../compaction/types";
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

/** The session facts an observer reads at one moment. */
export type SessionSnapshot = ReadonlyDeep<{
	catalogDiagnostic: string | null;
	compactions: SessionCompaction[];
	compactionError: Error | null;
	/** Session Context: the messages the next Agent Turn sends to the model. */
	context: SessionMessage[];
	error: Error | null;
	isCompacting: boolean;
	isPreparingMessage: boolean;
	status: SessionChatStatus;
	/** Session Transcript: the messages the session presents to the user. */
	transcript: SessionMessage[];
	viewState: SessionViewState | undefined;
}>;

export type SessionEngineOptions = ReadonlyDeep<{
	initialCompactions?: readonly SessionCompaction[];
	initialContext?: readonly SessionMessage[];
	initialTranscript: readonly SessionMessage[];
}>;

export type SessionEngine = Readonly<{
	/** Replaces the Session Context. */
	applyContext: (messages: readonly SessionMessage[]) => void;
	getSnapshot: () => SessionSnapshot;
	/**
	 * Merges messages into the Session Transcript: an existing message is
	 * replaced by id, an unknown one is appended, and a compaction summary
	 * never enters the Transcript.
	 */
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	recordCompaction: (entry: SessionCompaction) => void;
	setCatalogDiagnostic: (diagnostic: string | null) => void;
	setCompacting: (value: boolean) => void;
	setCompactionError: (error: Error | null) => void;
	setError: (error: Error | null) => void;
	setPreparingMessage: (value: boolean) => void;
	setStatus: (status: SessionChatStatus) => void;
	setViewState: (viewState: SessionViewState | undefined) => void;
	subscribe: (listener: () => void) => () => void;
}>;

const hasChanged = (
	state: SessionSnapshot,
	changes: Partial<SessionSnapshot>
): boolean =>
	(Object.keys(changes) as (keyof SessionSnapshot)[]).some(
		(key) => !Object.is(state[key], changes[key])
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
}: SessionEngineOptions): SessionEngine => {
	let state: SessionSnapshot = {
		catalogDiagnostic: null,
		compactions: [...initialCompactions],
		compactionError: null,
		context: [...(initialContext ?? initialTranscript)],
		error: null,
		isCompacting: false,
		isPreparingMessage: false,
		status: "ready",
		transcript: [...initialTranscript],
		viewState: undefined,
	};
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

	return {
		applyContext: (messages) => publish({ context: [...messages] }),
		getSnapshot: () => state,
		mergeTranscript,
		recordCompaction: (entry) => {
			if (state.compactions.some(({ id }) => id === entry.id)) {
				return;
			}
			publish({ compactions: [...state.compactions, entry] });
		},
		setCatalogDiagnostic: (diagnostic) =>
			publish({ catalogDiagnostic: diagnostic }),
		setCompacting: (value) => publish({ isCompacting: value }),
		setCompactionError: (error) => publish({ compactionError: error }),
		setError: (error) => publish({ error }),
		setPreparingMessage: (value) => publish({ isPreparingMessage: value }),
		setStatus: (status) => publish({ status }),
		setViewState: (viewState) => publish({ viewState }),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
};
