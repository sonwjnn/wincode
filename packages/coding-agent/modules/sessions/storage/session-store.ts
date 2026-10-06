import type {
	AgentId,
	AgentTurnId,
	SessionMessageId,
	SessionRecord,
	SessionRecordId,
	SessionRecordOutcome,
	SessionSubmissionStatus,
	SubmissionId,
	ToolCallId,
} from "@wincode/agent-core";
import type {
	ChatModelSelection,
	Effort,
	ReasoningMode,
} from "@wincode/ai/models";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { EditMode, FileObservationStore } from "@/modules/tools";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type {
	DelegationReportEnvelope,
	DelegationTask,
	DelegationTaskOutcome,
} from "../delegation/types";
import type {
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	SessionAttachmentStore,
} from "./attachment-store";
import type {
	SessionWriterLock,
	SessionWriterLockOptions,
} from "./session-writer-lock";

export type PromptHistoryEntry = {
	fileTokens?: Array<{ start: number; token: string }>;
	files: SessionFilePart[];
	text: string;
	pastedText?: Array<{ token: string; text: string }>;
};
export type SessionRecordStorageOutcome = SessionRecordOutcome;

export type Session = {
	createdAt: Date;
	id: SessionId;
	lastMessageAt: Date | null;
	model?: ChatModelSelection;
	pinned: boolean;
	reportContinuationPaused: boolean;
	title: string;
	effort?: Effort;
	reasoningMode?: ReasoningMode;
};

export type CreateSessionInput = {
	agent: AgentId;
	message: SessionMessage;
	model: ChatModelSelection;
	turnId: AgentTurnId;
	effort?: Effort;
	reasoningMode?: ReasoningMode;
};
export type CreateEmptySessionInput = Readonly<{
	model?: ChatModelSelection;
	effort?: Effort;
	reasoningMode?: ReasoningMode;
}>;
export type CreateDelegationTaskInput = CreateSessionInput & {
	parentSessionId: SessionId;
	parentToolCallId: ToolCallId;
	parentTurnId: AgentTurnId;
};
export type ConsumeDelegationReportInput = {
	assistantCheckpoint?: SessionRecord;
	parentSessionId: SessionId;
	record: SessionRecord;
	taskId: DelegationTaskId;
};

export type UpdateSessionInput = {
	pinned?: boolean;
	reportContinuationPaused?: boolean;
	title?: string;
};

/**
 * One semantic checkpoint: a Wincode Session Record for one accepted user
 * message, completed Tool Call, or terminal assistant outcome. The commit is
 * atomic at the SessionStore boundary; a rejected commit leaves no
 * partial durable state.
 */
export type CommitSessionRecordInput = {
	sessionModel?: ChatModelSelection;
	sessionEffort?: Effort;
	sessionReasoningMode?: ReasoningMode;
	record: SessionRecord;
	sessionId: SessionId;
};

export type UpdateSessionSubmissionInput = {
	failure?: string;
	messageId: SessionMessageId;
	recordId: SessionRecordId;
	sessionId: SessionId;
	status: SessionSubmissionStatus;
	submissionId: SubmissionId;
};

export type SessionStore = {
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
	createSession: (input: CreateSessionInput) => Promise<{ id: SessionId }>;
	createEmptySession: (
		input: CreateEmptySessionInput
	) => Promise<{ id: SessionId }>;
	deleteSession: (sessionId: SessionId) => Promise<void>;
	resetSessionData: () => Promise<void>;
	getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
	getLatestCompaction: (
		sessionId: SessionId
	) => Promise<SessionCompaction | null>;
	getSession: (sessionId: SessionId) => Promise<Session>;
	acquireSessionWriter: (
		sessionId: SessionId,
		options?: SessionWriterLockOptions
	) => Promise<SessionWriterLock>;
	listSessions: () => Promise<Session[]>;
	listRecentModelSelections: (limit: number) => ChatModelSelection[];
	commitSessionRecord: (input: CommitSessionRecordInput) => Promise<void>;
	listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
	createDelegatedTask: (
		input: CreateDelegationTaskInput
	) => Promise<DelegationTask>;
	consumeDelegationReport: (
		input: ConsumeDelegationReportInput
	) => Promise<boolean>;
	getDelegationTask: (
		taskId: DelegationTaskId
	) => Promise<DelegationTask | null>;
	getDelegationTaskForChild: (
		childSessionId: SessionId
	) => Promise<DelegationTask | null>;
	listDelegationTasks: (
		parentSessionId: SessionId
	) => Promise<DelegationTask[]>;
	listPendingDelegationReports: (
		parentSessionId: SessionId
	) => Promise<DelegationReportEnvelope[]>;
	markDelegationTaskAwaitingReport: (taskId: DelegationTaskId) => Promise<void>;
	recoverUncleanDelegationTasks: (
		excludeTaskIds?: readonly DelegationTaskId[]
	) => Promise<void>;
	settleDelegationTask: (input: {
		outcome: DelegationTaskOutcome;
		taskId: DelegationTaskId;
	}) => Promise<DelegationReportEnvelope | null>;
	updateSessionSubmission: (
		input: UpdateSessionSubmissionInput
	) => Promise<void>;
	updateSession: (
		sessionId: SessionId,
		data: UpdateSessionInput
	) => Promise<void>;
	getPromptHistory: () => Promise<PromptHistoryEntry[]>;
	recordPrompt: (entry: PromptHistoryEntry) => Promise<void>;
	clearPromptHistory: () => Promise<void>;
	getEditMode?: (sessionId: SessionId) => Promise<EditMode>;
	setEditMode?: (sessionId: SessionId, mode: EditMode) => Promise<void>;
	fileObservationStore?: FileObservationStore;
	attachmentStore?: SessionAttachmentStore;
	hydrateAttachments: (
		messages: readonly SessionMessage[],
		options: AttachmentHydrationOptions
	) => Promise<SessionMessage[]>;
	externalizeAttachments: (
		messages: readonly SessionMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<SessionMessage[]>;
	collectAttachments: (
		safetyWindowMs?: number
	) => Promise<AttachmentMaintenanceReport>;
};
export const UNTITLED_SESSION_TITLE = "Untitled Session";
