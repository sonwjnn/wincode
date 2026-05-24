import { devToolsMiddleware } from "@ai-sdk/devtools";
import { openai } from "@ai-sdk/openai";
import { zValidator } from "@hono/zod-validator";
import {
	convertToModelMessages,
	createIdGenerator,
	safeValidateUIMessages,
	stepCountIs,
	streamText,
	tool,
	type UIMessage,
	wrapLanguageModel,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";
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

const tools = {
	get_weather: tool({
		description: "Get the current weather in a given city",
		inputSchema: z.object({
			city: z.string().describe("The city to get the weather for"),
		}),
		execute: ({ city }) => {
			const conditions = ["sunny", "cloudy", "rainy", "snowy"] as const;
			const condition =
				conditions[Math.floor(Math.random() * conditions.length)];

			return { city, condition };
		},
	}),
};

const createChatStreamResponse = async (
	id: string,
	validatedMessages: UIMessage[],
	sendReasoning = true
) => {
	await persistChatMessages(id, validatedMessages);
	const model = wrapLanguageModel({
		model: openai("gpt-5.4-mini"),
		middleware: devToolsMiddleware(),
	});
	const result = streamText({
		model,
		messages: await convertToModelMessages(validatedMessages),
		providerOptions: {
			anthropic: {
				thinking: { type: "adaptive" },
			},
			google: {
				thinkingConfig: { includeThoughts: true },
			},
			openai: {
				reasoningSummary: "detailed",
			},
		},
		stopWhen: stepCountIs(5),
		system: "Use get_weather for weather requests.",
		tools,
	});

	return result.toUIMessageStreamResponse({
		generateMessageId: createIdGenerator({
			prefix: "msg",
			size: 16,
		}),
		onFinish: async ({ messages: finishedMessages }) => {
			await persistChatMessages(id, finishedMessages);
		},
		originalMessages: validatedMessages,
		sendReasoning,
	});
};

export const sessionsRoutes = new Hono()
	.post("/", zValidator("json", createSessionRequestSchema), async (c) => {
		const { message } = c.req.valid("json");
		const validation = await safeValidateUIMessages({ messages: [message] });

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
			const hasPersistedMessage = persistedMessages.some(
				(persistedMessage) => persistedMessage.id === message?.id
			);
			const messages =
				message && !hasPersistedMessage
					? [...persistedMessages, message]
					: persistedMessages;
			const validation = await safeValidateUIMessages({ messages });

			if (!validation.success) {
				return c.json({ error: "Invalid chat messages" }, 400);
			}

			return createChatStreamResponse(id, validation.data, sendReasoning);
		}
	);
