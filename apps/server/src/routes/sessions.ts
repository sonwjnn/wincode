import { zValidator } from "@hono/zod-validator";
import type { CodingAgentUIMessage } from "@wincode/ai";
import { createCodingAgentStreamResponse } from "@wincode/ai/server";
import { safeValidateUIMessages } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { mergeChatMessage } from "./chat-message-merge";
import {
	createChatSession,
	getChatMessages,
	persistChatMessages,
} from "./chat-persistence";

const sessionParamsSchema = z.object({
	id: z.string().min(1),
});

const uiMessagePartSchema = z
	.object({
		type: z.string().min(1),
	})
	.passthrough();

const uiMessageInputSchema = z.object({
	id: z.string().min(1),
	metadata: z.unknown().optional(),
	parts: z.array(uiMessagePartSchema),
	role: z.enum(["system", "user", "assistant"]),
});

const chatRequestSchema = z.object({
	message: uiMessageInputSchema.optional(),
	sendReasoning: z.boolean().optional(),
});

const createSessionRequestSchema = z.object({
	message: uiMessageInputSchema,
});

const createChatStreamResponse = async (
	id: string,
	validatedMessages: CodingAgentUIMessage[],
	sendReasoning = true
) => {
	await persistChatMessages(id, validatedMessages);

	return createCodingAgentStreamResponse({
		onFinish: async ({ messages: finishedMessages }) => {
			await persistChatMessages(id, finishedMessages);
		},
		sendReasoning,
		uiMessages: validatedMessages,
	});
};

export const sessionsRoutes = new Hono()
	.post("/", zValidator("json", createSessionRequestSchema), async (c) => {
		const { message } = c.req.valid("json");
		const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
			messages: [message],
		});

		if (!validation.success) {
			return c.json({ error: "Invalid chat message" }, 400);
		}

		return c.json(await createChatSession(validation.data), 201);
	})
	.get("/:id/messages", zValidator("param", sessionParamsSchema), async (c) => {
		const { id } = c.req.valid("param");
		return c.json({ messages: await getChatMessages(id) });
	})
	.post(
		"/:id/chat",
		zValidator("param", sessionParamsSchema),
		zValidator("json", chatRequestSchema),
		async (c) => {
			const { id } = c.req.valid("param");
			const { message, sendReasoning } = c.req.valid("json");
			const persistedMessages = await getChatMessages(id);
			const messages = mergeChatMessage(persistedMessages, message);
			const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
				messages,
			});

			if (!validation.success) {
				return c.json({ error: "Invalid chat messages" }, 400);
			}

			return createChatStreamResponse(id, validation.data, sendReasoning);
		}
	);
