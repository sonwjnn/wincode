import type {
	AgentId,
	SessionRecord,
	SessionRecordOutcome,
} from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type {
	SessionFilePart,
	SessionMessage,
} from "@/modules/sessions/message";
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

export type PromptHistoryEntry = {
	fileTokens?: Array<{ start: number; token: string }>;
	files: SessionFilePart[];
	text: string;
	pastedText?: Array<{ token: string; text: string }>;
};
export type SessionRecordStorageOutcome = SessionRecordOutcome;

export type Session = {
	createdAt: Date;
	id: string;
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
	turnId: string;
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
	sessionId: string;
};

export type SessionStore = {
	appendCompaction: (
		input: AppendSessionCompactionInput
	) => Promise<SessionCompaction>;
	createSession: (input: CreateSessionInput) => Promise<{ id: string }>;
	deleteSession: (sessionId: string) => Promise<void>;
	resetSessionData: () => Promise<void>;
	getCompactions: (sessionId: string) => Promise<SessionCompaction[]>;
	getLatestCompaction: (sessionId: string) => Promise<SessionCompaction | null>;
	getSession: (sessionId: string) => Promise<Session>;
	listSessions: () => Promise<Session[]>;
	listRecentModelSelections: (limit: number) => ChatModelSelection[];
	commitSessionRecord: (input: CommitSessionRecordInput) => Promise<void>;
	listSessionRecords: (sessionId: string) => Promise<SessionRecord[]>;
	updateSession: (sessionId: string, data: UpdateSessionInput) => Promise<void>;
	getPromptHistory: () => Promise<PromptHistoryEntry[]>;
	recordPrompt: (entry: PromptHistoryEntry) => Promise<void>;
	clearPromptHistory: () => Promise<void>;
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
