import type {
	AgentId,
	AgentTurn,
	AgentTurnEvent,
	AgentTurnId,
	AgentTurnTerminalEvent,
	ResolvedAgent,
	SessionMessageId,
	SessionRecord,
	ToolCallId,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type { CodingToolName } from "@wincode/coding-tools";
import type {
	SkillContext,
	SkillExecution,
	SkillRequestContext,
	SkillToolDefinition,
} from "@wincode/skills";
import type { ReadonlyDeep } from "type-fest";
import type { QueuedSubmissionId, SessionId } from "@/shared/identifiers";
import type { ToolApprovalRequest } from "@/shared/providers/approval/types";
import type {
	CompactSessionResult,
	SessionCompactionModule,
} from "../compaction/compaction";
import type { ResolvedCompactionSettings } from "../compaction/config";
import type { OverflowRecoveryError } from "../compaction/overflow-recovery";
import type {
	CompactionTriggerReason,
	SessionCompaction,
} from "../compaction/types";
import type { SessionViewState } from "../hooks/runtime-turn";
import type { FileMentionPart, SessionMessage } from "../message";
import type {
	SessionSendInput,
	SessionSendOutcome,
	SessionSubmissionComposition,
} from "../session-operation";

export type { SessionViewState } from "../hooks/runtime-turn";

/**
 * One live Agent Turn execution the Engine tracks, oldest first. Its view
 * state belongs to that execution alone, so a delegated Subagent never
 * replaces the view of the execution that spawned it.
 */
export type SessionExecution = ReadonlyDeep<{
	/** The Agent the execution runs as. */
	agent: AgentId;
	/** The assistant Session Message the execution streams into. */
	assistantId: SessionMessageId;
	/** The Model Target selection the execution runs against. */
	model: ChatModelSelection;
	/** Set for a delegated Subagent execution: the turn and Tool Call it came from. */
	parent?: AgentTurn["delegation"];
	/** The session-level selection recorded on this execution's Session Records. */
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	/** The Session Context message this execution answers. */
	sourceUserMessageId: SessionMessageId | null;
	startedAt: number;
	turnId: AgentTurnId;
	variant?: ModelVariant;
	viewState?: SessionViewState;
}>;

/** One settlement decision for an approval request. */
export type SessionApprovalOutcome =
	| { decision: "abort" }
	| { decision: "allow"; remember: boolean }
	| { decision: "reject"; feedback?: string };

/**
 * The send the Engine runs when the Submission Queue reaches a Queued
 * Submission: the submission as it was accepted, with the composition and the
 * Model Target selection it keeps while it waits.
 */
export type SessionQueuedSendInput = SessionSendInput & {
	composition: SessionSubmissionComposition;
};

/**
 * One Submission a busy session accepted and holds instead of running: the send
 * it will run, and its identifier. It is transient Engine state, never a
 * Session Record, and it enters the Session Transcript only when it starts
 * running.
 */
export type SessionQueuedSubmission = ReadonlyDeep<{
	id: QueuedSubmissionId;
	input: SessionQueuedSendInput;
}>;

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
	/**
	 * Submission Queue: the Queued Submissions waiting for their Agent Turn,
	 * oldest first. It is drain order, never a Session Record.
	 */
	queuedSubmissions: SessionQueuedSubmission[];
	/** Whether the session is running a submission, from its command to its settle. */
	turnActive: boolean;
	/** Session Transcript: the messages the session presents to the user. */
	transcript: SessionMessage[];
	/**
	 * The live view of the most recently active execution, so the parent's view
	 * returns when a delegated Subagent ends.
	 */
	viewState: SessionViewState | undefined;
}>;

/** What starts one Agent Turn execution. */
export type SessionExecutionInput = ReadonlyDeep<{
	agent: AgentId;
	model: ChatModelSelection;
	parent?: AgentTurn["delegation"];
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	/** The Session Context message this execution answers, when known. */
	sourceUserMessageId?: SessionMessageId;
	startedAt: number;
	/** The Agent Turn Identifier; generated when the caller has none yet. */
	turnId?: AgentTurnId;
	variant?: ModelVariant;
}>;

/**
 * The resolved Agent one Agent Turn runs as, as the host resolved it: the
 * Engine forwards it to its runtime port and never reads it, so the port names
 * only the domain fields a host must supply.
 */
export type SessionResolvedAgent = Readonly<
	ResolvedAgent & {
		requiresManualApproval?: boolean;
		visibleCodingTools: readonly CodingToolName[];
	}
>;

/** One durable Session Record commit the Engine performs. */
export type SessionCommitInput = {
	record: SessionRecord;
	sessionId: SessionId;
	sessionModel?: ChatModelSelection;
	sessionVariant?: ModelVariant;
};

/** The attachment ceilings one submission resolved from its compaction settings. */
export type SessionAttachmentBudget = ReadonlyDeep<{
	maxAttachments: number;
	maxBytes: number;
	maxTokens: number;
}>;

/** What one Agent Turn asks the host's attachment store to hydrate. */
export type SessionHydrationRequest = ReadonlyDeep<{
	budget: SessionAttachmentBudget;
	messages: readonly SessionMessage[];
	priorityMessageId?: SessionMessageId;
	signal: AbortSignal;
}>;

/** The Skill catalog one Agent Turn arms and runs with, created by the host. */
export type SessionSkillCatalog = Readonly<{
	/** The catalog diagnostic the Session Snapshot publishes, when there is one. */
	diagnostic: string | null;
	execution: SkillExecution;
	tool?: SkillToolDefinition;
}>;

/** What resolving one submission's Skill produced. */
export type SessionSkillResolution =
	| { readonly ok: true; readonly skill?: SkillRequestContext }
	| { readonly ok: false; readonly reason: string };

/** The Skills one session may arm and load. */
export type SessionSkillPort = Readonly<{
	/** Arms the Skill catalog the next Agent Turn runs with. */
	createTurnSkill: () => Promise<SessionSkillCatalog>;
	/**
	 * Resolves the Skill a submission asks for — the one it names, or the one
	 * its source message recorded — against an armed catalog.
	 */
	resolveSkill: (
		explicitSkill: SkillContext | undefined,
		anchoredMessage: SessionMessage | undefined,
		armedSkill: SessionSkillCatalog
	) => Promise<SessionSkillResolution>;
}>;

/** The attachments a submission carries and a turn sends. */
export type SessionAttachmentPort = Readonly<{
	/** Stores the attachment data of a fresh user message. */
	externalize: (
		messages: readonly SessionMessage[],
		signal: AbortSignal
	) => Promise<SessionMessage[]>;
	/** Hydrates the attachment data of the messages one Agent Turn sends. */
	hydrate: (request: SessionHydrationRequest) => Promise<SessionMessage[]>;
	/**
	 * Keeps attachment blobs alive past the records and prompt history that
	 * name them, so a waiting composition's attachments cannot be reclaimed.
	 */
	retain: (attachmentIds: readonly string[]) => void;
	/** Releases blobs the composition that needed them no longer holds. */
	release: (attachmentIds: readonly string[]) => void;
}>;

/**
 * What the Agent Runtime reports about one Agent Turn execution. The Engine
 * owns every state write; the host reports events, and commits the Durable
 * Session Records the runtime produced through the Engine.
 */
export type SessionTurnCallbacks = Readonly<{
	/** Commits the terminal Session Record of the execution. */
	commitTerminal: (record: SessionRecord) => Promise<void>;
	/** Commits each completed Tool Call as its own Session Record. */
	commitToolCall: (record: SessionRecord) => Promise<void>;
	/** Reports one non-terminal Agent Turn event, in order. */
	onEvent: (event: AgentTurnEvent) => void;
	/** Reports the terminal event the execution ended with. */
	onTerminal: (event: AgentTurnTerminalEvent) => void;
	/** Reports the execution's live Session View State. */
	onViewState: (viewState: SessionViewState) => void;
}>;

/** One Agent Turn execution the host runs against the Agent Runtime. */
export type SessionTurnRequest = Readonly<{
	/** The Skill catalog the submission armed for this execution. */
	armedSkill: SessionSkillCatalog;
	/** Reports what happens inside the execution back to the Engine. */
	callbacks: SessionTurnCallbacks;
	/** The Agent Turn execution the host runs. */
	execution: SessionExecution;
	/** The hydrated messages the Agent Turn sends to the model. */
	messages: readonly SessionMessage[];
	/** The resolved Agent the execution runs as. */
	resolvedAgent: SessionResolvedAgent;
	/** The Skill this execution's turn must load, when the submission asked for one. */
	skillRequest?: SkillRequestContext;
	signal: AbortSignal;
}>;

/** What one Agent Turn execution reported to the Engine. */
export type SessionTurnOutcome = Readonly<{
	/** The failure that ended the execution, when it ended without a terminal event. */
	error?: unknown;
	/** The Agent Turn the host built, when it got that far. */
	turn?: AgentTurn;
}>;

/** The Agent Runtime capability one session runs its Agent Turns through. */
export type SessionRuntimePort = Readonly<{
	/** The request overhead of the Agent Turn execution in flight, in tokens. */
	requestOverheadTokens: () => number;
	/** Runs one Agent Turn execution and reports what it did through the callbacks. */
	run: (request: SessionTurnRequest) => Promise<SessionTurnOutcome>;
}>;

/**
 * The host capabilities the Engine runs a session with. The Engine owns the
 * session's state and its command ordering; a port only performs the work the
 * Engine asks for and reports what happened.
 */
export type SessionEnginePorts = Readonly<{
	attachments: SessionAttachmentPort;
	/** The Session Compaction module whose per-session in-flight map owns admission. */
	compaction: SessionCompactionPort;
	/** Writes one durable Session Record. */
	commitRecord: (input: SessionCommitInput) => Promise<void>;
	/** Resolves the @path file mentions of a prompt. */
	resolveFileMentions: (text: string) => Promise<FileMentionPart[]>;
	/** Resolves the compaction settings one Model Target runs with. */
	resolveCompactionSettings: (
		selection: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	runtime: SessionRuntimePort;
	skills: SessionSkillPort;
}>;

export type SessionEngineOptions = ReadonlyDeep<{
	initialCompactions?: readonly SessionCompaction[];
	initialContext?: readonly SessionMessage[];
	initialTranscript: readonly SessionMessage[];
	ports: SessionEnginePorts;
	sessionId: SessionId;
}>;

/** What one replay attempt asks the host to run: the turn's original message. */
export type SessionOverflowReplayInput = ReadonlyDeep<{
	originalMessageId: SessionMessageId;
}>;

/**
 * What one replay attempt reported: the Agent Turn it starts, or the refusal
 * that stopped it. A refusal — a send the session already runs — is reported
 * instead of overlapped, and the recovery never queues it.
 */
export type SessionOverflowReplayOutcome =
	| { readonly kind: "started" }
	| { readonly kind: "refused"; readonly reason: string };

/** The Model Target one overflow recovery compacts and replays with. */
export type SessionOverflowRecoveryTarget = ReadonlyDeep<{
	model: ChatModelSelection;
	variant?: ModelVariant;
}>;

/** One provider refusal proposed to the Engine for overflow recovery. */
export type SessionOverflowRecoveryCommand = ReadonlyDeep<{
	/** The failure that ended the Agent Turn; anything but an overflow is ignored. */
	error: unknown;
	/** The user message the failed Agent Turn answered; the recovery replays it. */
	originalMessageId: SessionMessageId;
	/**
	 * The Model Target the recovery's compaction runs against, or null when that
	 * target has no overflow recovery available.
	 */
	resolveTarget: () => Promise<SessionOverflowRecoveryTarget | null>;
	/** Runs the replay once the recovery has compacted. */
	replay: (
		input: SessionOverflowReplayInput
	) => Promise<SessionOverflowReplayOutcome>;
	/** The Agent Turn whose provider request overflowed. */
	turnId: AgentTurnId;
}>;

/**
 * What one overflow recovery did: it compacted and replayed the message, the
 * failure was not eligible, the message had already used its one attempt, or
 * the recovery failed and published that failure as the compaction error.
 */
export type SessionOverflowRecoveryOutcome =
	| { readonly kind: "recovered"; readonly entry: SessionCompaction }
	| { readonly kind: "ineligible" }
	| { readonly kind: "exhausted" }
	| { readonly kind: "failed"; readonly error: OverflowRecoveryError };

/**
 * The Session Compaction module the Engine submits compaction commands to. Its
 * per-session in-flight map owns the admission decision: a request either runs,
 * joins one that carries the same intent, or is refused.
 */
export type SessionCompactionPort = Pick<
	SessionCompactionModule,
	"compact" | "getInFlight" | "needsCompaction"
>;

/** One compaction request as the Session Command the Engine runs. */
export type SessionCompactionCommand = ReadonlyDeep<{
	focus?: string;
	model: ChatModelSelection;
	/** Merged into the Session Transcript before compacting, when supplied. */
	nextMessages?: readonly SessionMessage[];
	/** Compacted in place of the Session Transcript, when supplied. */
	sourceMessages?: readonly SessionMessage[];
	trigger: CompactionTriggerReason;
	variant?: ModelVariant;
}>;

export type SessionEngine = Readonly<{
	/**
	 * Ends the Agent Turn an abort-settled approval belongs to: settles every
	 * remaining pending request and preserves the interrupted Tool Call, so the
	 * session stops waiting exactly once.
	 */
	abortApprovalTurn: (toolCallId: ToolCallId) => void;
	/** Replaces the Session Context. */
	applyContext: (messages: readonly SessionMessage[]) => void;
	/** Registers a starting Agent Turn execution and its parent linkage. */
	beginExecution: (execution: SessionExecutionInput) => SessionExecution;
	/** Cancels the Agent Turn the session is running. */
	cancel: () => void;
	/**
	 * Aborts the compaction command in flight and recalls the queued
	 * submissions with it: cancelling maintenance is still stopping work, and
	 * stopping work hands the waiting text back.
	 */
	cancelCompaction: () => SessionQueuedSubmission[];
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
	 * Interrupts the Agent Turn the session is running: the send ends, the
	 * assistant message it streams into keeps the interrupted Tool Call
	 * visible, and the Queued Submissions come back for the composer instead of
	 * draining, so stopping work never strands waiting text.
	 */
	interrupt: (preserveToolCallId?: ToolCallId) => SessionQueuedSubmission[];
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
	/**
	 * Proposes the one recovery an Agent Turn may get from a provider refusal.
	 * A failure that is not a context overflow, or one whose Model Target has no
	 * overflow recovery, is ignored. The first eligible refusal records the user
	 * message it answers, compacts the replay-safe history through the Engine's
	 * own compaction command, and replays that message once the turn that
	 * proposed the recovery has ended; every later refusal of the message is
	 * refused as exhausted, so no new send can start a second attempt. A failed
	 * or refused recovery is published as the compaction error.
	 */
	recoverOverflow: (
		command: SessionOverflowRecoveryCommand
	) => Promise<SessionOverflowRecoveryOutcome>;
	/**
	 * Withdraws the Queued Submissions for the composer, oldest first. Without
	 * identifiers the whole queue is recalled; an identifier that names nothing
	 * waiting is a no-op, so a submission that already started running is never
	 * recalled and never runs twice. The recalled submissions leave the queue,
	 * so nothing auto-starts once the current work ends.
	 */
	recallQueuedSubmissions: (
		ids?: readonly QueuedSubmissionId[]
	) => SessionQueuedSubmission[];
	/** Replaces one execution's Session View State, never another's. */
	setExecutionViewState: (
		turnId: AgentTurnId,
		viewState: SessionViewState
	) => void;
	/**
	 * Waits until no compaction command is in flight, so the Session Context a
	 * caller reads next is the settled one. Reports the failure that ended the
	 * wait, when a command ends with one.
	 */
	settleCompaction: () => Promise<Error | null>;
	/**
	 * Ends the session: it cancels the Agent Turn the session is running,
	 * settles every pending approval through the same path, and refuses later
	 * requests, so nothing keeps running invisibly and nothing stays waiting on
	 * a session that is gone.
	 */
	shutdown: () => void;
	/**
	 * Sends one submission as a Session Command. A submission that arrives
	 * while the session is busy — a running Agent Turn or a compaction in
	 * flight — becomes a Queued Submission instead of being refused, and is
	 * accepted with the composition and Model Target selection it arrived with.
	 */
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	subscribe: (listener: () => void) => () => void;
}>;
