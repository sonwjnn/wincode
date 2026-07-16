import {
	type CodingAgentUIMessage,
	codingAgentDataSchemas,
	codingMessageMetadataSchema,
	codingModeNameSchema,
	modelVariantSchema,
} from "@wincode/ai";
import {
	codingServerTools,
	createCodingAgentStreamResponse,
	type ResolvedModel,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
} from "@wincode/ai/server";
import { safeValidateUIMessages } from "ai";
import { Hono } from "hono";
import { z } from "zod";
import {
	requireScope,
	unauthorizedHeaders,
	verifyBearerAuth,
} from "../auth/credentials";

const maxRequestBytes = 256 * 1024;
const maxMessages = 32;
const maxPartsPerMessage = 16;
const maxTextLength = 16 * 1024;
const maxIdLength = 256;

const uiMessagePartSchema = z
	.object({
		text: z.string().max(maxTextLength).optional(),
		type: z.string().min(1),
	})
	.passthrough();

const uiMessageInputSchema = z.object({
	id: z.string().min(1).max(maxIdLength),
	metadata: codingMessageMetadataSchema.optional(),
	parts: z.array(uiMessagePartSchema).max(maxPartsPerMessage),
	role: z.enum(["system", "user", "assistant"]),
});

const chatRequestSchema = z.object({
	messages: z.array(uiMessageInputSchema).max(maxMessages),
	mode: codingModeNameSchema,
	model: z
		.string()
		.min(1)
		.refine((value) => {
			try {
				resolveWincodeChatModelSelection(value);
				return true;
			} catch {
				return false;
			}
		}, "Unsupported host model"),
	variant: modelVariantSchema.optional(),
	sendReasoning: z.boolean().optional(),
});

const badRequest = () =>
	new Response(JSON.stringify({ error: "Bad Request" }), {
		headers: { "content-type": "application/json; charset=utf-8" },
		status: 400,
	});

const withChatMetadata = (
	message: z.infer<typeof uiMessageInputSchema>,
	mode: z.infer<typeof codingModeNameSchema>,
	model: { modelId: string; providerId: "wincode" },
	variant?: string
) => ({
	...message,
	metadata: {
		...message.metadata,
		mode,
		model,
		...(variant === undefined ? {} : { variant }),
	},
});

const withChatMetadataForMessages = (
	messages: z.infer<typeof uiMessageInputSchema>[],
	mode: z.infer<typeof codingModeNameSchema>,
	model: { modelId: string; providerId: "wincode" },
	variant?: string
) => messages.map((message) => withChatMetadata(message, mode, model, variant));

const hasValidContentLength = (value: string | null) => {
	if (!value) {
		return true;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 && parsed <= maxRequestBytes;
};

const readBoundedJsonBody = async (request: Request): Promise<unknown> => {
	const body = request.body;
	if (!body) {
		throw new Error("empty body");
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let receivedBytes = 0;
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			receivedBytes += value.byteLength;
			if (receivedBytes > maxRequestBytes) {
				throw new Error("request too large");
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text) as unknown;
	} finally {
		reader.cancel().catch(() => undefined);
	}
};

// Transport-only chat stream for local-first CLI conversations. The CLI owns
// conversation persistence in local SQLite; the server never reads or writes
// PostgreSQL chat tables. Full UI message context arrives in the request body.
export const sessionsRoutes = new Hono().post("/:id/chat", async (c) => {
	const subject = await verifyBearerAuth(c.req.header("authorization") ?? null);
	if (!subject) {
		return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
	}
	if (!requireScope(subject, "chat:write")) {
		return c.json({ error: "Forbidden" }, 403);
	}
	const contentLength = c.req.header("content-length") ?? null;
	if (!hasValidContentLength(contentLength)) {
		return badRequest();
	}

	let body: unknown;
	try {
		body = await readBoundedJsonBody(c.req.raw);
	} catch {
		return badRequest();
	}

	const parsed = chatRequestSchema.safeParse(body);
	if (!parsed.success) {
		return badRequest();
	}

	const { messages, mode, model, sendReasoning, variant } = parsed.data;
	let resolvedModel: ResolvedModel;
	let resolvedSelection: ReturnType<typeof resolveWincodeChatModelSelection>;
	try {
		resolvedSelection = resolveWincodeChatModelSelection(model);
		resolvedModel = resolveSupportedChatModel(resolvedSelection, { variant });
	} catch {
		return badRequest();
	}
	const modelSelection = {
		modelId: resolvedSelection.id,
		providerId: "wincode" as const,
	};
	const stagedMessages = withChatMetadataForMessages(
		messages,
		mode,
		modelSelection,
		variant
	).map((message) => ({
		...message,
		metadata: message.metadata,
		parts: message.parts,
	}));

	const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
		dataSchemas: codingAgentDataSchemas,
		messages: stagedMessages,
		tools: codingServerTools,
	});

	if (!validation.success) {
		return badRequest();
	}

	return createCodingAgentStreamResponse({
		model: resolvedModel.model,
		modelId: resolvedModel.modelId,
		maxOutputTokens: resolvedModel.maxOutputTokens,
		mode,
		providerOptions: resolvedModel.providerOptions,
		sendReasoning,
		uiMessages: validation.data,
	});
});
