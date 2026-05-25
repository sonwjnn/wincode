import { devToolsMiddleware } from "@ai-sdk/devtools";
import { openai } from "@ai-sdk/openai";
import { zValidator } from "@hono/zod-validator";
import {
	convertToModelMessages,
	createIdGenerator,
	safeValidateUIMessages,
	stepCountIs,
	streamText,
	type UIMessage,
	wrapLanguageModel,
} from "ai";
import { Hono } from "hono";
import { z } from "zod";
import { codingTools } from "../agent";
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

const codingAgentPrompt = `You are a basic coding agent running in a user's CLI.
Use tools to inspect and modify files before answering about code.
All file tools are limited to the CLI workspace. Bash runs with cwd set to the workspace, but it is not sandboxed and can escape the workspace; prefer file tools when strict workspace containment matters.
Use list, grep, and read before editing. Prefer edit for targeted changes and write for new files or full rewrites. Run relevant checks with bash after changes.`;

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
		stopWhen: stepCountIs(20),
		system: codingAgentPrompt,
		tools: codingTools,
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
			const messages = mergeChatMessage(persistedMessages, message);
			const validation = await safeValidateUIMessages({ messages });

			if (!validation.success) {
				return c.json({ error: "Invalid chat messages" }, 400);
			}

			return createChatStreamResponse(id, validation.data, sendReasoning);
		}
	);
