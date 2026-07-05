import type {
	CodingAgentUIMessage,
	ModeType,
	SupportedChatModelId,
} from "@wincode/ai";

export type ConversationSession = {
	createdAt: Date;
	id: string;
	lastMessageAt: Date | null;
	pinned: boolean;
	title: string;
};

export type CreateSessionInput = {
	message: CodingAgentUIMessage;
	mode: ModeType;
	model: SupportedChatModelId;
};

export type UpdateSessionInput = {
	pinned?: boolean;
	title?: string;
};

export type PersistMessagesInput = {
	messages: CodingAgentUIMessage[];
	mode: ModeType;
	model: SupportedChatModelId;
	sessionId: string;
};

export type ConversationStore = {
	createSession: (input: CreateSessionInput) => Promise<{ id: string }>;
	deleteSession: (sessionId: string) => Promise<void>;
	getMessages: (sessionId: string) => Promise<CodingAgentUIMessage[]>;
	getSession: (sessionId: string) => Promise<ConversationSession>;
	listSessions: () => Promise<ConversationSession[]>;
	persistMessages: (input: PersistMessagesInput) => Promise<void>;
	updateSession: (sessionId: string, data: UpdateSessionInput) => Promise<void>;
};

export const UNTITLED_SESSION_TITLE = "Untitled Session";
