import type { CodingAgentUIMessage } from "@wincode/ai";
import prisma, { type Prisma } from "@wincode/db";
import { generateId, safeValidateUIMessages } from "ai";

type ChatMessagePayload = {
	metadata?: Prisma.InputJsonValue;
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
	position: number
): ChatMessagePayload => {
	const payload: ChatMessagePayload = {
		parts: toJsonValue(message.parts),
		position,
		role: message.role,
		sessionId,
		uiMessageId: message.id,
	};

	if (message.metadata !== undefined) {
		payload.metadata = toJsonValue(message.metadata);
	}

	return payload;
};

export const createChatSession = async (
	messages: CodingAgentUIMessage[] = []
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
		await persistChatMessages(session.id, messages);
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
			metadata: message.metadata ?? undefined,
			parts: message.parts,
			role: message.role,
		})),
	});

	if (!validation.success) {
		throw new Error("Invalid persisted chat messages.");
	}

	return validation.data;
};

export const persistChatMessages = async (
	sessionId: string,
	messages: CodingAgentUIMessage[]
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
			const payload = buildMessagePayload(sessionId, message, position);
			return prisma.chatMessage.upsert({
				create: payload,
				update: {
					metadata: payload.metadata,
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
