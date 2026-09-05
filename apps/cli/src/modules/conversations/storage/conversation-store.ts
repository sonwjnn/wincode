import type { AgentId, ConversationRecord } from "@wincode/agent-core";
import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import type {
	ConversationFilePart,
	ConversationMessage,
} from "@/modules/conversations/message";
import type {
	AppendConversationCompactionInput,
	ConversationCompaction,
} from "../compaction/types";
import type {
	AttachmentExternalizationOptions,
	AttachmentHydrationOptions,
	AttachmentMaintenanceReport,
	ConversationAttachmentStore,
} from "./attachment-store";

export type PromptHistoryEntry = {
	fileTokens?: Array<{ start: number; token: string }>;
	files: ConversationFilePart[];
	text: string;
	pastedText?: Array<{ token: string; text: string }>;
};

export type ConversationSession = {
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
	message: ConversationMessage;
	model: ChatModelSelection;
	variant?: ModelVariant;
};

export type UpdateSessionInput = {
	pinned?: boolean;
	title?: string;
};

/**
 * One semantic checkpoint: the Wincode Conversation Record committed for one
 * Agent Turn under a session. The commit is atomic at the ConversationStore
 * boundary; a rejected commit leaves no partial durable state.
 */
export type CommitConversationRecordInput = {
	record: ConversationRecord;
	sessionId: string;
};

export type ConversationStore = {
	appendCompaction: (
		input: AppendConversationCompactionInput
	) => Promise<ConversationCompaction>;
	createSession: (input: CreateSessionInput) => Promise<{ id: string }>;
	deleteSession: (sessionId: string) => Promise<void>;
	getCompactions: (sessionId: string) => Promise<ConversationCompaction[]>;
	getLatestCompaction: (
		sessionId: string
	) => Promise<ConversationCompaction | null>;
	getSession: (sessionId: string) => Promise<ConversationSession>;
	listSessions: () => Promise<ConversationSession[]>;
	listRecentModelSelections: (limit: number) => ChatModelSelection[];
	commitConversationRecord: (
		input: CommitConversationRecordInput
	) => Promise<void>;
	listConversationRecords: (sessionId: string) => Promise<ConversationRecord[]>;
	updateSession: (sessionId: string, data: UpdateSessionInput) => Promise<void>;
	getPromptHistory: () => Promise<PromptHistoryEntry[]>;
	recordPrompt: (entry: PromptHistoryEntry) => Promise<void>;
	clearPromptHistory: () => Promise<void>;
	attachmentStore?: ConversationAttachmentStore;
	hydrateAttachments: (
		messages: readonly ConversationMessage[],
		options: AttachmentHydrationOptions
	) => Promise<ConversationMessage[]>;
	externalizeAttachments: (
		messages: readonly ConversationMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<ConversationMessage[]>;
	collectAttachments: (
		safetyWindowMs?: number
	) => Promise<AttachmentMaintenanceReport>;
};
export const UNTITLED_SESSION_TITLE = "Untitled Session";
