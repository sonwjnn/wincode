import type {
	AgentId,
	AgentTurnId,
	SessionRecord,
	SessionRecordOutcome,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
import type { EditMode, FileObservationStore } from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";
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
import type { SessionLease, SessionLeaseOptions } from "./session-lease";

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
	title: string;
	variant?: ModelVariant;
};

export type CreateSessionInput = {
	agent: AgentId;
	message: SessionMessage;
	model: ChatModelSelection;
	turnId: AgentTurnId;
	variant?: ModelVariant;
};

export type UpdateSessionInput = {
	pinned?: boolean;
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
	sessionVariant?: ModelVariant;
	record: SessionRecord;
	sessionId: SessionId;
};

export type SessionStore = {
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
	createSession: (input: CreateSessionInput) => Promise<{ id: SessionId }>;
	deleteSession: (sessionId: SessionId) => Promise<void>;
	resetSessionData: () => Promise<void>;
	getCompactions: (sessionId: SessionId) => Promise<SessionCompaction[]>;
	getLatestCompaction: (
		sessionId: SessionId
	) => Promise<SessionCompaction | null>;
	getSession: (sessionId: SessionId) => Promise<Session>;
	acquireSessionLease: (
		sessionId: SessionId,
		options?: SessionLeaseOptions
	) => Promise<SessionLease>;
	listSessions: () => Promise<Session[]>;
	listRecentModelSelections: (limit: number) => ChatModelSelection[];
	commitSessionRecord: (input: CommitSessionRecordInput) => Promise<void>;
	listSessionRecords: (sessionId: SessionId) => Promise<SessionRecord[]>;
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
