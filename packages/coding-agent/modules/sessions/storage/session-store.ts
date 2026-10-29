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
	pastedText?: Array<{ start?: number; token: string; text: string }>;
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

export type CreateSessionInput = {
	id?: SessionId;
	agent: AgentId;
	message: SessionMessage;
	model: ProviderModelSelection;
	turnId: AgentTurnId;
	thinkingLevel?: ThinkingLevel;
};
export type CreateEmptySessionInput = Readonly<{
	id?: SessionId;
	model?: ProviderModelSelection;
	thinkingLevel?: ThinkingLevel;
}>;
export type UpdateSessionInput = {
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
 * atomic at the SessionStore boundary; a rejected commit leaves no
 * partial durable state.
 */
export type CommitSessionRecordInput = {
	sessionModel?: ProviderModelSelection;
	sessionThinkingLevel?: ThinkingLevel;
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
	createSessionUsageEntry: (
		input: CreateSessionUsageEntryInput
	) => Promise<SessionUsageEntry>;
	listSessionUsageEntries: (
		sessionId: SessionId
	) => Promise<SessionUsageEntry[]>;
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
