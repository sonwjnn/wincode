import type {
	AgentId,
	ChatModelSelection,
	CodingAgentUIMessage,
	ModeType,
} from "@wincode/ai";
import type { FileUIPart } from "@wincode/ai/client";

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
	pinned: boolean;
	title: string;
};

export type CreateSessionInput = {
	agent: AgentId;
	message: CodingAgentUIMessage;
	mode: ModeType;
	model: ChatModelSelection;
};

export type UpdateSessionInput = {
	pinned?: boolean;
	title?: string;
};

export type PersistMessagesInput = {
	agent: AgentId;
	messages: CodingAgentUIMessage[];
	mode: ModeType;
	model: ChatModelSelection;
	sessionId: string;
};

export type ConversationStore = {
	createSession: (input: CreateSessionInput) => Promise<{ id: string }>;
	deleteSession: (sessionId: string) => Promise<void>;
	getMessages: (sessionId: string) => Promise<CodingAgentUIMessage[]>;
	getSession: (sessionId: string) => Promise<ConversationSession>;
	listSessions: () => Promise<ConversationSession[]>;
	listRecentModelSelections: (limit: number) => ChatModelSelection[];
	persistMessages: (input: PersistMessagesInput) => Promise<void>;
	updateSession: (sessionId: string, data: UpdateSessionInput) => Promise<void>;
	getPromptHistory: () => PromptHistoryEntry[];
	recordPrompt: (entry: PromptHistoryEntry) => void;
};

export const UNTITLED_SESSION_TITLE = "Untitled Session";
