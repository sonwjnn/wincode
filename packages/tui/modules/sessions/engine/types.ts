import type {
	AgentTurn,
	AgentTurnEvent,
	AgentTurnId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { ReadonlyDeep } from "type-fest";
import type { SessionId } from "@/shared/identifiers";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionInput,
	CompactSessionResult,
	SessionCompactionModule,
} from "../compaction/compaction";
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
