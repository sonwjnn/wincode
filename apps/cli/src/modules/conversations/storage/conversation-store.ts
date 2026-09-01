import type {
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	ModelVariant,
} from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";
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
	files: FileUIPart[];
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
	message: CodingAgentUIMessage;
	model: ChatModelSelection;
	variant?: ModelVariant;
};

export type UpdateSessionInput = {
	pinned?: boolean;
	title?: string;
};

export type PersistMessagesInput = {
	agent: AgentId;
	messages: CodingAgentUIMessage[];
	model: ChatModelSelection;
	sessionId: string;
	variant?: ModelVariant;
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
	getMessages: (sessionId: string) => Promise<CodingAgentUIMessage[]>;
	getSession: (sessionId: string) => Promise<ConversationSession>;
	listSessions: () => Promise<ConversationSession[]>;
	listRecentModelSelections: (limit: number) => ChatModelSelection[];
	persistMessages: (input: PersistMessagesInput) => Promise<void>;
	updateSession: (sessionId: string, data: UpdateSessionInput) => Promise<void>;
	getPromptHistory: () => Promise<PromptHistoryEntry[]>;
	recordPrompt: (entry: PromptHistoryEntry) => Promise<void>;
	clearPromptHistory: () => Promise<void>;
	attachmentStore?: ConversationAttachmentStore;
	hydrateAttachments: (
		messages: readonly CodingAgentUIMessage[],
		options: AttachmentHydrationOptions
	) => Promise<CodingAgentUIMessage[]>;
	externalizeAttachments: (
		messages: readonly CodingAgentUIMessage[],
		signal?: AbortSignal,
		options?: AttachmentExternalizationOptions
	) => Promise<CodingAgentUIMessage[]>;
	collectAttachments: (
		safetyWindowMs?: number
	) => Promise<AttachmentMaintenanceReport>;
};
export const UNTITLED_SESSION_TITLE = "Untitled Session";
