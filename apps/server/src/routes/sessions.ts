import { zValidator } from "@hono/zod-validator";
import {
	type CodingAgentUIMessage,
	codingModeNameSchema,
	type SupportedChatModelId,
	supportedChatModelIdSchema,
} from "@wincode/ai";
import {
	codingServerTools,
	createCodingAgentStreamResponse,
	resolveChatModel,
} from "@wincode/ai/server";
import { safeValidateUIMessages } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import {
	createChatSession,
	getChatMessages,
	listChatSessions,
	persistChatMessages,
} from "../services/chat-persistence";
import { mergeChatMessage } from "../utils/chat-message-merge";

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
	mode: codingModeNameSchema,
	model: supportedChatModelIdSchema,
	sendReasoning: z.boolean().optional(),
});

const createSessionRequestSchema = z.object({
	message: uiMessageInputSchema,
	mode: codingModeNameSchema,
	model: supportedChatModelIdSchema,
});

const withChatMetadata = (
	message: z.infer<typeof uiMessageInputSchema>,
	mode: z.infer<typeof codingModeNameSchema>,
	model: SupportedChatModelId
) => ({
	...message,
	metadata: {
		...(typeof message.metadata === "object" && message.metadata !== null
			? message.metadata
			: {}),
		mode,
		model,
	},
});

const createChatStreamResponse = async (
	id: string,
	validatedMessages: CodingAgentUIMessage[],
	mode: z.infer<typeof codingModeNameSchema>,
	modelId: SupportedChatModelId,
	sendReasoning = true
) => {
	const resolvedModel = resolveChatModel(modelId);

	await persistChatMessages(id, validatedMessages, mode, modelId);

	return createCodingAgentStreamResponse({
		model: resolvedModel.model,
		modelId: resolvedModel.modelId,
		mode,
		onFinish: async ({ messages: finishedMessages }) => {
			await persistChatMessages(id, finishedMessages, mode, modelId);
		},
		providerOptions: resolvedModel.providerOptions,
		sendReasoning,
		uiMessages: validatedMessages,
	});
};

export const sessionsRoutes = new Hono()
	.get("/", async (c) => c.json(await listChatSessions()))
	.post("/", zValidator("json", createSessionRequestSchema), async (c) => {
		const { message, mode, model } = c.req.valid("json");
		const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
			messages: [withChatMetadata(message, mode, model)],
			tools: codingServerTools,
		});

		if (!validation.success) {
			return c.json({ error: "Invalid chat message" }, 400);
		}

		return c.json(await createChatSession(validation.data, mode, model), 201);
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
			const { message, mode, model, sendReasoning } = c.req.valid("json");
			const persistedMessages = await getChatMessages(id);
			const messages = mergeChatMessage(
				persistedMessages,
				message ? withChatMetadata(message, mode, model) : message
			);
			const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
				messages,
				tools: codingServerTools,
			});

			if (!validation.success) {
				return c.json({ error: "Invalid chat messages" }, 400);
			}

			return createChatStreamResponse(
				id,
				validation.data,
				mode,
				model,
				sendReasoning
			);
		}
	);
