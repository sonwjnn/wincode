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
import type { ReadonlyDeep } from "type-fest";
import type {
	SkillContext,
	SkillExecution,
	SkillRequestContext,
	SkillToolDefinition,
} from "@/modules/skills";
import type { CodingToolName } from "@/modules/tools";
import type {
	QueuedSubmissionId,
	SessionId,
	SteeringMessageId,
	SubmissionId,
} from "@/shared/identifiers";
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
 * The disposition the Agent Session chose for one admitted Submission.
 * Prompt reports this before provider work starts.
 */
export type SessionSubmissionDisposition = "started" | "queued";

export type SessionSubmissionAdmission =
	| { readonly rejected: true; readonly reason: string }
	| {
			readonly rejected: false;
			readonly disposition: SessionSubmissionDisposition;
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly turnId?: AgentTurnId;
	  };

export type SessionSteeringAdmission =
	| { readonly rejected: true; readonly reason: string }
	| {
			readonly rejected: false;
			readonly disposition: "steering";
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly turnId: AgentTurnId;
	  };

export type SessionContinuationOutcome =
	| { readonly kind: "rejected"; readonly reason: string }
	| { readonly kind: "resumed"; readonly turnId: AgentTurnId }
	| {
			readonly kind: "started-submission";
			readonly messageId: SessionMessageId;
			readonly submissionId: SubmissionId;
			readonly turnId?: AgentTurnId;
	  };

export type SessionSubmissionEvent = Readonly<{
	kind: "started" | "delivered" | "recalled" | "failed";
	messageId: SessionMessageId;
	reason?: string;
	submissionId: SubmissionId;
	turnId?: AgentTurnId;
}>;
export type SessionInterruptResult = Readonly<{
	approvalsSettled: number;
	kind: "turn" | "compaction" | "none";
	recalled: SessionWaitingMessage[];
}>;

/**
 * One live Agent Turn execution the Agent Session tracks, oldest first. Its
 * view state belongs to that execution alone, so a delegated Subagent never
 * replaces the view of the execution that spawned it.
 */
export type SessionExecution = ReadonlyDeep<{
	/** The Submission that admitted this execution, when user-originated. */
	submissionId?: SubmissionId;
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

/** One result from the Agent Session's approval settlement command. */
export type SessionApprovalResult =
	| { readonly applied: true }
	| {
			readonly applied: false;
			readonly reason?: "persistence-forbidden";
	  };

/** One settlement decision for an approval request. */
export type SessionApprovalOutcome =
	| { decision: "abort" }
	| { decision: "allow"; remember: boolean }
	| { decision: "reject"; feedback?: string };

/**
 * The input the Agent Session starts when the Submission Queue reaches a
 * Queued Submission: the submission as it was accepted, with the composition
 * and Model Target selection it keeps while it waits.
 */
export type SessionQueuedSendInput = SessionSendInput & {
	composition: SessionSubmissionComposition;
};

/**
 * One Submission a busy session accepted and holds instead of running: the send
 * it will run, and its identifier. It is transient Agent Session state, never
 * a Session Record, and it enters the Session Transcript only when it starts
 * running.
 */
export type SessionQueuedSubmission = ReadonlyDeep<{
	id: QueuedSubmissionId;
	messageId: SessionMessageId;
	submissionId: SubmissionId;
	input: SessionQueuedSendInput;
}>;

/**
 * The send a Steering Message runs when the Agent Turn it joined reaches a
 * Model Step boundary: text only, on the Model Target the running turn already
 * runs with, so a mid-turn correction cannot switch anything under the user.
 * It keeps everything a fallback submission needs to run as its own Agent Turn
 * when the turn that accepted it reaches no boundary.
 */
export type SessionSteeringSendInput = Readonly<{
	agent: AgentId;
	/** The composition the Strip shows and a Recall restores. */
	composition: SessionSubmissionComposition;
	model: ChatModelSelection;
	resolvedAgent?: SessionResolvedAgent;
	sessionModel: ChatModelSelection;
	sessionVariant?: ModelVariant;
	submissionId?: SubmissionId;
	messageId?: SessionMessageId;
	text: string;
	turnId?: AgentTurnId;
	variant?: ModelVariant;
}>;

/**
 * One Steering Message a running Agent Turn accepted and holds for its next
 * Model Step boundary. It is transient Agent Session state, never a Session
 * Record until it is delivered, and is never restored after a restart.
 */
export type SessionSteeringMessage = ReadonlyDeep<{
	id: SteeringMessageId;
	input: SessionSteeringSendInput;
}>;

/** One user message the Agent Session withdrew from a lane for the composer. */
export type SessionWaitingMessage =
	| SessionQueuedSubmission
	| SessionSteeringMessage;

export type SessionWaitingMessageId =
	| QueuedSubmissionId
	| SteeringMessageId
	| SubmissionId;

/**
 * One approval request the Agent Session owns until it settles. `target` is
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
	/** Approval requests the Agent Session owns, oldest first, settled ones included. */
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
	/**
	 * Steering Lane: the Steering Messages waiting for the next Model Step
	 * boundary of the running Agent Turn, oldest first. It is delivery order,
	 * never a Session Record until it is delivered.
	 */
	steeringMessages: SessionSteeringMessage[];
	/** Whether the session is running a submission, from its command to its settle. */
	turnActive: boolean;
	/** Session Transcript: the messages the session presents to the user. */
	transcript: SessionMessage[];
	/** Monotonic internal revision for durable transcript changes. */
	transcriptRevision?: number;
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
	submissionId?: SubmissionId;
	/** The Session Context message this execution answers, when known. */
	sourceUserMessageId?: SessionMessageId;
	startedAt: number;
	/** The Agent Turn Identifier; generated when the caller has none yet. */
	turnId?: AgentTurnId;
	variant?: ModelVariant;
}>;

/**
 * The resolved Agent one Agent Turn runs as, as the Host resolved it. The
 * Agent Session forwards it to its runtime port and never reads it, so the
 * port names only the domain fields a Host must supply.
 */
export type SessionResolvedAgent = Readonly<
	ResolvedAgent & {
		requiresManualApproval?: boolean;
		visibleCodingTools: readonly CodingToolName[];
	}
>;

/** One durable Session Record commit the Agent Session performs. */
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
 * What the Agent Runtime reports about one Agent Turn execution. The Agent
 * Session owns every state write; the Host reports events and commits the
 * Durable Session Records the runtime produced through the Agent Session.
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
	/** Reports what happens inside the execution back to the Agent Session. */
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
	/**
	 * Hands the runtime the Steering Messages that joined this execution since
	 * the last call, oldest first, at a Model Step boundary. The Agent Session
	 * pops the Steering Lane and commits Session Records as it answers, so
	 * delivery and commit are atomic.
	 */
	takeSteeringMessages: () => readonly SessionMessage[];
}>;

/** What one Agent Turn execution reported to the Agent Session. */
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
 * The Host capabilities an Agent Session runs with. The Agent Session owns the
 * session's state and command ordering; each port performs work it requests.
 */
export type AgentSessionPorts = Readonly<{
	attachments: SessionAttachmentPort;
	/** The Session Compaction module whose per-session in-flight map owns admission. */
	compaction: SessionCompactionPort;
	/** Writes one durable Session Record. */
	commitRecord: (input: SessionCommitInput) => Promise<void>;
	/** Resolves the Agent, Model, and variant when a Submission starts. */
	resolveSubmission: (input: SessionSendInput) => SessionSendInput;
	/** Resolves the @path file mentions of a prompt. */
	resolveFileMentions: (text: string) => Promise<FileMentionPart[]>;
	/** Resolves the compaction settings one Model Target runs with. */
	resolveCompactionSettings: (
		selection: ChatModelSelection
	) => Promise<ResolvedCompactionSettings>;
	runtime: SessionRuntimePort;
	skills: SessionSkillPort;
}>;

export type AgentSessionOptions = ReadonlyDeep<{
	initialCompactions?: readonly SessionCompaction[];
	initialAgent?: AgentId;
	initialContext?: readonly SessionMessage[];
	initialSessionModel?: ChatModelSelection;
	initialSessionVariant?: ModelVariant;
	initialTranscript: readonly SessionMessage[];
	ports: AgentSessionPorts;
	sessionId: SessionId;
}>;

/** What one context continuation asks the Host to run: the original user message. */
export type SessionOverflowContinuationInput = ReadonlyDeep<{
	originalMessageId: SessionMessageId;
}>;

/**
 * What one context continuation reported: the Agent Turn it starts, or the
 * refusal that stopped it. A refusal — an active Session Command — is reported
 * instead of overlapped, and the recovery never queues it.
 */
export type SessionOverflowContinuationOutcome =
	| { readonly kind: "started" }
	| { readonly kind: "refused"; readonly reason: string };

/** The Model Target one overflow recovery compacts and continues with. */
export type SessionOverflowRecoveryTarget = ReadonlyDeep<{
	model: ChatModelSelection;
	variant?: ModelVariant;
}>;

/** One provider refusal proposed to the Agent Session for overflow recovery. */
export type SessionOverflowRecoveryCommand = ReadonlyDeep<{
	/** The failure that ended the Agent Turn; anything but an overflow is ignored. */
	error: unknown;
	/** The user message the failed Agent Turn answered; continuation resumes it. */
	originalMessageId: SessionMessageId;
	/**
	 * The Model Target the recovery's compaction runs against, or null when that
	 * target has no overflow recovery available.
	 */
	resolveTarget: () => Promise<SessionOverflowRecoveryTarget | null>;
	/** Continues the existing context once the recovery has compacted. */
	continueContext: (
		input: SessionOverflowContinuationInput
	) => Promise<SessionOverflowContinuationOutcome>;
	/** The Agent Turn whose provider request overflowed. */
	turnId: AgentTurnId;
}>;

/**
 * What one overflow recovery did: it compacted and continued the existing
 * context, the failure was not eligible, the message had already used its one
 * attempt, or the recovery failed and published that failure as the compaction
 * error.
 */
export type SessionOverflowRecoveryOutcome =
	| { readonly kind: "recovered"; readonly entry: SessionCompaction }
	| { readonly kind: "ineligible" }
	| { readonly kind: "exhausted" }
	| { readonly kind: "failed"; readonly error: OverflowRecoveryError };

/**
 * The Session Compaction module the Agent Session submits compaction commands
 * to. Its per-session in-flight map owns admission: a request runs, joins one
 * with the same intent, or is refused.
 */
export type SessionCompactionPort = Pick<
	SessionCompactionModule,
	"compact" | "getInFlight" | "needsCompaction"
>;

/** One compaction request as a Session Command the Agent Session runs. */
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

export type AgentSession = Readonly<{
	/** Starts a new Submission or admits it to the FIFO Submission Queue. */
	prompt: (input: SessionSendInput) => Promise<SessionSubmissionAdmission>;
	/** Delivers a text-only correction to a running Agent Turn. */
	steer: (text: string) => SessionSteeringAdmission;
	/** Resumes a valid idle context or starts the next waiting user input. */
	continue: () => SessionContinuationOutcome;
	/**
	 * Writes one durable Session Record while the Agent Session still owns the
	 * session. Late runtime callbacks are ignored after shutdown.
	 */
	commitRecord: (input: SessionCommitInput) => Promise<void>;
	/** Replaces the Session Context. */
	applyContext: (messages: readonly SessionMessage[]) => void;
	/** Registers a starting Agent Turn execution and its parent linkage. */
	beginExecution: (execution: SessionExecutionInput) => SessionExecution;
	/** Cancels the Agent Turn the session is running. */
	cancel: () => void;
	/**
	 * Ends the Agent Turn an abort-settled approval belongs to: settles every
	 * remaining pending request and preserves the interrupted Tool Call, so the
	 * session stops waiting exactly once.
	 */
	abortApprovalTurn: (toolCallId: ToolCallId) => void;
	/**
	 * Aborts the compaction command in flight and recalls the waiting messages
	 * with it.
	 */
	cancelCompaction: () => SessionWaitingMessage[];
	/** Settles every pending approval as rejected. */
	closeApprovals: (feedback?: string) => void;
	/** Runs a compaction command. */
	compact: (command: SessionCompactionCommand) => Promise<CompactSessionResult>;
	/** Drops an execution and everything that belonged to it. */
	endExecution: (turnId: AgentTurnId) => void;
	getSnapshot: () => SessionSnapshot;
	/** Reports work that can still write or settle after shutdown starts. */
	hasPendingWork: () => boolean;
	/** Interrupts the active Agent Turn and recalls all waiting work. */
	interrupt: (preserveToolCallId?: ToolCallId) => SessionWaitingMessage[];
	/** Interrupts compaction or the active turn and recalls waiting work atomically. */
	interruptAll: () => SessionInterruptResult;
	/** Merges messages into the Session Transcript by message identity. */
	mergeTranscript: (
		messages: readonly SessionMessage[]
	) => readonly SessionMessage[];
	/** Creates one pending approval owned by the Agent Session. */
	requestApproval: (
		request: ToolApprovalRequest
	) => Promise<SessionApprovalOutcome>;
	/** Settles one pending approval; an already settled request is left alone. */
	respondToApproval: (
		id: string,
		outcome: SessionApprovalOutcome
	) => SessionApprovalResult;
	/** Proposes the one overflow recovery an Agent Turn may get. */
	recoverOverflow: (
		command: SessionOverflowRecoveryCommand
	) => Promise<SessionOverflowRecoveryOutcome>;
	/** Withdraws waiting user messages back to the composer. */
	recallWaitingMessages: (
		ids?: readonly SessionWaitingMessageId[]
	) => SessionWaitingMessage[];
	/** Replaces one execution's Session View State, never another's. */
	setExecutionViewState: (
		turnId: AgentTurnId,
		viewState: SessionViewState
	) => void;
	/** Waits until no compaction command is in flight. */
	settleCompaction: () => Promise<Error | null>;
	/** Ends the session after active durable cleanup has completed. */
	shutdown: () => Promise<void>;
	/**
	 * Compatibility entry point. A busy send still routes to steering or the
	 * Submission Queue using the historical automatic policy.
	 */
	send: (input: SessionSendInput) => Promise<SessionSendOutcome>;
	onSubmissionEvent: (
		listener: (event: SessionSubmissionEvent) => void
	) => () => void;
	subscribe: (listener: () => void) => () => void;
}>;
