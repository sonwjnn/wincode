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

	await prisma.chatSession.upsert({
		create: {
			id: sessionId,
			lastMessageAt,
		},
		update: {
			lastMessageAt,
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
