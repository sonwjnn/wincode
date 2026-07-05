import { zValidator } from "@hono/zod-validator";
import {
	type CodingAgentUIMessage,
	codingAgentDataSchemas,
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
	messages: z.array(uiMessageInputSchema),
	mode: codingModeNameSchema,
	model: supportedChatModelIdSchema,
	sendReasoning: z.boolean().optional(),
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

const withChatMetadataForMessages = (
	messages: z.infer<typeof uiMessageInputSchema>[],
	mode: z.infer<typeof codingModeNameSchema>,
	model: SupportedChatModelId
) => messages.map((message) => withChatMetadata(message, mode, model));

// Transport-only chat stream for local-first CLI conversations. The CLI owns
// conversation persistence in local SQLite; the server never reads or writes
// PostgreSQL chat tables. Full UI message context arrives in the request body.
export const sessionsRoutes = new Hono().post(
	"/:id/chat",
	zValidator("json", chatRequestSchema),
	async (c) => {
		const { messages, mode, model, sendReasoning } = c.req.valid("json");
		const stagedMessages = withChatMetadataForMessages(messages, mode, model);
		const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
			dataSchemas: codingAgentDataSchemas,
			messages: stagedMessages,
			tools: codingServerTools,
		});

		if (!validation.success) {
			return c.json({ error: "Invalid chat messages" }, 400);
		}

		const resolvedModel = resolveChatModel(model);
		return createCodingAgentStreamResponse({
			model: resolvedModel.model,
			modelId: resolvedModel.modelId,
			mode,
			providerOptions: resolvedModel.providerOptions,
			sendReasoning,
			uiMessages: validation.data,
		});
	}
);
