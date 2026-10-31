import type {
	AgentId,
	AgentTurnId,
	SessionMessageId,
	SessionRecord,
	SessionRecordId,
	SessionRecordOutcome,
	SessionSubmissionStatus,
	SubmissionId,
} from "@wincode/agent-core";
import type { ModelUsage, ThinkingLevel } from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { EditMode, FileObservationStore } from "@/modules/tools";
import type { SessionId, SessionUsageEntryId } from "@/shared/identifiers";
import type {
	AppendSessionCompactionInput,
	SessionCompaction,
} from "../compaction/types";
import type { SessionWriteOutcome } from "../session-write-outcome";
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

export type {
	SessionWriteFailure,
	SessionWriteOutcome,
	SessionWriteReceipt,
} from "../session-write-outcome";

export type PromptHistoryEntry = {
	fileTokens?: Array<{ start: number; token: string }>;
	files: SessionFilePart[];
	text: string;
	pastedText?: Array<{ start: number; token: string; text: string }>;
};
export type SessionRecordStorageOutcome = SessionRecordOutcome;

export type Session = {
	createdAt: Date;
	id: SessionId;
	lastMessageAt: Date | null;
	model?: ProviderModelSelection;
	pinned: boolean;
	title: string;
	thinkingLevel?: ThinkingLevel;
};

export type SessionCatalogIssue = Readonly<{
	code: string;
	message: string;
	sessionId: SessionId;
}>;

export type SessionCatalogResult = Readonly<{
	issues: SessionCatalogIssue[];
	sessions: Session[];
}>;

export type CreateSessionInput = {
	createdAt?: Date;
	id?: SessionId;
	initialRecord?: SessionRecord;
	agent: AgentId;
	message: SessionMessage;
	model: ProviderModelSelection;
	turnId: AgentTurnId;
	thinkingLevel?: ThinkingLevel;
};
export type CreateEmptySessionInput = Readonly<{
	createdAt?: Date;
	id?: SessionId;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;
export type UpdateSessionInput = {
	operationId?: string;
	pinned?: boolean;
	title?: string;
};

/** Durable usage-only accounting that never projects into a Session Record. */
export type SessionUsageEntry = Readonly<{
	createdAt: Date;
	id: SessionUsageEntryId;
	kind: "cache-warm" | "compaction-summary";
	model: ProviderModelSelection;
	sessionId: SessionId;
	usage: ModelUsage;
}>;

export type CreateSessionUsageEntryInput = Omit<
	SessionUsageEntry,
	"createdAt"
> & {
	createdAt?: Date;
};

/**
 * One semantic checkpoint: a Wincode Session Record for one accepted user
 * message, completed Tool Call, or terminal assistant outcome. The commit is
 * atomic at the SessionStore boundary; its tagged outcome distinguishes a
 * refused write from an indeterminate publication.
 */
export type CommitSessionRecordInput = {
	sessionModel?: ProviderModelSelection;
	sessionThinkingLevel?: ThinkingLevel;
	record: SessionRecord;
	sessionId: SessionId;
};

export type UpdateSessionSubmissionInput = {
	operationId?: string;
	failure?: string;
	messageId: SessionMessageId;
	recordId: SessionRecordId;
	sessionId: SessionId;
	status: SessionSubmissionStatus;
	submissionId: SubmissionId;
};

export type SessionProjectionStore = {
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
	createSession: (
		input: CreateSessionInput
	) => Promise<{ created?: boolean; id: SessionId }>;
	createSessionUsageEntry: (
		input: CreateSessionUsageEntryInput
	) => Promise<SessionUsageEntry>;
	listSessionUsageEntries: (
		sessionId: SessionId
	) => Promise<SessionUsageEntry[]>;
	createEmptySession: (
		input: CreateEmptySessionInput
	) => Promise<{ created?: boolean; id: SessionId }>;
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
	listRecentModelSelections: (limit: number) => ProviderModelSelection[];
	commitSessionRecord: (input: CommitSessionRecordInput) => Promise<void>;
	listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
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
	setEditMode?: (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	) => Promise<void>;
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

export type SessionCompactionWriteResult = Readonly<{
	compaction?: SessionCompaction;
	writeOutcome: SessionWriteOutcome;
}>;

export type SessionStore = Omit<
	SessionProjectionStore,
	| "appendCompaction"
	| "commitSessionRecord"
	| "createEmptySession"
	| "createSession"
	| "createSessionUsageEntry"
	| "deleteSession"
	| "setEditMode"
	| "updateSession"
	| "updateSessionSubmission"
> & {
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompactionWriteResult>;
	commitSessionRecord: (
		input: CommitSessionRecordInput
	) => Promise<SessionWriteOutcome>;
	createEmptySession: (input: CreateEmptySessionInput) => Promise<{
		created?: boolean;
		id: SessionId;
		writeOutcome: SessionWriteOutcome;
	}>;
	createSession: (input: CreateSessionInput) => Promise<{
		created?: boolean;
		id: SessionId;
		writeOutcome: SessionWriteOutcome;
	}>;
	createSessionUsageEntry: (input: CreateSessionUsageEntryInput) => Promise<{
		entry?: SessionUsageEntry;
		writeOutcome: SessionWriteOutcome;
	}>;
	deleteSession: (sessionId: SessionId) => Promise<SessionWriteOutcome>;
	listSessionCatalog: () => Promise<SessionCatalogResult>;
	setEditMode?: (
		sessionId: SessionId,
		mode: EditMode,
		operationId?: string
	) => Promise<SessionWriteOutcome>;
	updateSession: (
		sessionId: SessionId,
		data: UpdateSessionInput
	) => Promise<SessionWriteOutcome>;
	updateSessionSubmission: (
		input: UpdateSessionSubmissionInput
	) => Promise<SessionWriteOutcome>;
};
export const UNTITLED_SESSION_TITLE = "Untitled Session";
