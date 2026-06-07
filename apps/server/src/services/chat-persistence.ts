import type {
	CodingAgentUIMessage,
	ModeType,
	SupportedChatModelId,
} from "@wincode/ai";
import { parseMode } from "@wincode/ai";
import { codingServerTools } from "@wincode/ai/server";
import prisma, { type Prisma } from "@wincode/db";
import { generateId, safeValidateUIMessages } from "ai";
import {
	getSessionTitle,
	resolveLoadedChatMessageMetadata,
	resolvePersistedChatMessageMetadata,
} from "./chat-message-metadata";

type ChatMessagePayload = {
	metadata?: Prisma.InputJsonValue;
	mode: ModeType;
	parts: Prisma.InputJsonValue;
	position: number;
	role: CodingAgentUIMessage["role"];
	sessionId: string;
	uiMessageId: string;
};

const toJsonValue = (value: unknown): Prisma.InputJsonValue =>
	JSON.parse(JSON.stringify(value));

const buildMessagePayload = (
	sessionId: string,
	message: CodingAgentUIMessage,
	position: number,
	fallbackMode: ModeType,
	model: SupportedChatModelId
): ChatMessagePayload => {
	const metadata = resolvePersistedChatMessageMetadata(
		message.metadata,
		fallbackMode,
		model
	);
	const payload: ChatMessagePayload = {
		metadata: toJsonValue(metadata),
		mode: metadata.mode ?? fallbackMode,
		parts: toJsonValue(message.parts),
		position,
		role: message.role,
		sessionId,
		uiMessageId: message.id,
	};

	return payload;
};

export const createChatSession = async (
	messages: CodingAgentUIMessage[],
	mode: ModeType,
	model: SupportedChatModelId
) => {
	const session = await prisma.chatSession.create({
		data: {
			id: generateId(),
			title: getSessionTitle(messages),
		},
		select: {
			id: true,
		},
	});

	if (messages.length > 0) {
		await persistChatMessages(session.id, messages, mode, model);
	}

	return session;
};

export const listChatSessions = async () => {
	const sessions = await prisma.chatSession.findMany({
		orderBy: [
			{ pinned: "desc" },
			{ lastMessageAt: "desc" },
			{ createdAt: "desc" },
		],
		select: {
			createdAt: true,
			id: true,
			lastMessageAt: true,
			messages: {
				orderBy: { position: "asc" },
				select: {
					parts: true,
					role: true,
				},
			},
			pinned: true,
			title: true,
		},
	});

	return sessions.map((session) => ({
		createdAt: session.createdAt,
		id: session.id,
		lastMessageAt: session.lastMessageAt,
		pinned: session.pinned,
		title: session.title ?? getSessionTitle(session.messages),
	}));
};

export const getChatSession = async (sessionId: string) => {
	const session = await prisma.chatSession.findUnique({
		select: {
			createdAt: true,
			id: true,
			lastMessageAt: true,
			pinned: true,
			title: true,
		},
		where: { id: sessionId },
	});

	if (!session) {
		throw new Error("Session not found");
	}

	return session;
};

export const deleteChatSession = async (sessionId: string) => {
	await prisma.chatSession.delete({
		where: { id: sessionId },
	});
};

export const updateChatSession = async (
	sessionId: string,
	data: { title?: string; pinned?: boolean }
) => {
	await prisma.chatSession.update({
		data,
		where: { id: sessionId },
	});
};

export const getChatMessages = async (
	sessionId: string
): Promise<CodingAgentUIMessage[]> => {
	const messages = await prisma.chatMessage.findMany({
		orderBy: {
			position: "asc",
		},
		select: {
			metadata: true,
			mode: true,
			parts: true,
			role: true,
			uiMessageId: true,
		},
		where: {
			sessionId,
		},
	});

	if (messages.length === 0) {
		return [];
	}

	const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
		messages: messages.map((message) => ({
			id: message.uiMessageId,
			metadata: resolveLoadedChatMessageMetadata(
				message.metadata,
				parseMode(message.mode)
			),
			parts: message.parts,
			role: message.role,
		})),
		tools: codingServerTools,
	});

	if (!validation.success) {
		throw new Error("Invalid persisted chat messages.");
	}

	return validation.data;
};

export const persistChatMessages = async (
	sessionId: string,
	messages: CodingAgentUIMessage[],
	mode: ModeType,
	model: SupportedChatModelId
) => {
	const lastMessageAt = new Date();
	const title = getSessionTitle(messages);

	await prisma.chatSession.upsert({
		create: {
			id: sessionId,
			lastMessageAt,
			title,
		},
		update: {
			lastMessageAt,
			title,
		},
		where: { id: sessionId },
	});

	await Promise.all(
		messages.map((message, position) => {
			const payload = buildMessagePayload(
				sessionId,
				message,
				position,
				mode,
				model
			);
			return prisma.chatMessage.upsert({
				create: payload,
				update: {
					metadata: payload.metadata,
					mode: payload.mode,
					parts: payload.parts,
					position: payload.position,
					role: payload.role,
				},
				where: {
					sessionId_uiMessageId: {
						sessionId,
						uiMessageId: message.id,
					},
				},
			});
		})
	);
};
