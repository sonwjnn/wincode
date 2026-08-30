import {
	type CodingAgentUIMessage,
	codingAgentDataSchemas,
	codingMessageMetadataSchema,
	codingToolDefinitions,
	editModelInputJsonSchema,
	formatSkillUserContext,
	getSystemInstructionsForAgent,
	hostedAgentDescriptorSchema,
	modelVariantSchema,
	skillRequestContextSchema,
	skillToolDefinitionSchema,
	toCodingMessageUsage,
} from "@wincode/ai";
import {
	codingServerTools,
	convertMcpToolManifest,
	createCodingAgentStreamResponse,
	getProviderErrorMessage,
	type ResolvedModel,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
} from "@wincode/ai/server";
import { createDrizzleClient } from "@wincode/db/client";
import { generateText, safeValidateUIMessages } from "ai";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
	requireScope,
	unauthorizedHeaders,
	verifyBearerAuth,
} from "../auth/credentials";
import { getBillingConfig } from "../billing/config";
import { createBillingLifecycle } from "../billing/lifecycle";
import type { BillingRepository } from "../billing/repository";
import { createBillingRepository } from "../billing/repository";

const maxRequestBytes = 80 * 1024 * 1024;
const maxMessages = 32;
const maxPartsPerMessage = 16;
const maxIdLength = 256;
const conservativeHardInputTokenLimit = 16_384;
const conservativeInputHeadroomTokens = 512;
const estimatedUtf8BytesPerToken = 4;

const billingReserveDeniedMessage = (reason: unknown): string =>
	typeof reason === "string"
		? `Billing reserve denied: ${reason}`
		: "Billing reserve denied";

const billingConfig = {
	providerKillSwitches: new Set<string>(),
	modelKillSwitches: new Set<string>(),
};

const uiMessagePartSchema = z
	.object({
		text: z.string().optional(),
		type: z.string().min(1),
	})
	.passthrough();
const uiMessageInputSchema = z.object({
	id: z.string().min(1).max(maxIdLength),
	metadata: codingMessageMetadataSchema.optional(),
	parts: z.array(uiMessagePartSchema).max(maxPartsPerMessage),
	role: z.enum(["system", "user", "assistant"]),
});
const chatRequestSchema = z
	.object({
		agent: hostedAgentDescriptorSchema,
		messages: z.array(uiMessageInputSchema).max(maxMessages),
		model: z.string().min(1),
		persist: z.literal(false).optional(),
		variant: modelVariantSchema.optional(),
		sendReasoning: z.boolean().optional(),
		skill: skillRequestContextSchema.optional(),
		skillTool: skillToolDefinitionSchema.optional(),
	})
	.strict();

const compactionSummarySchema = z
	.object({
		coveredMessageIds: z.array(z.string().min(1)),
		formatVersion: z.literal(1),
		text: z.string(),
		focus: z.string().optional(),
	})
	.strict();
const compactionSummaryRequestSchema = z
	.object({
		focus: z.string().max(4096).optional(),
		model: z.string().min(1),
		previousSummary: compactionSummarySchema.optional(),
		serializedMessages: z.string().min(1).max(4_000_000),
		variant: modelVariantSchema.optional(),
	})
	.strict();

const badRequest = () =>
	new Response(JSON.stringify({ error: "Bad Request" }), {
		headers: { "content-type": "application/json; charset=utf-8" },
		status: 400,
	});

const forbidden = (error = "Forbidden") =>
	new Response(JSON.stringify({ error }), {
		headers: { "content-type": "application/json; charset=utf-8" },
		status: 403,
	});

const withChatMetadata = (
	message: z.infer<typeof uiMessageInputSchema>,
	model: { modelId: string; providerId: string },
	variant?: string
) => {
	const { agent: _agent, ...metadata } = message.metadata ?? {};
	return {
		...message,
		metadata: {
			...metadata,
			model,
			...(variant === undefined ? {} : { variant }),
		},
	};
};

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

const COMPACTION_SUMMARY_SYSTEM_PROMPT = `You are Wincode's conversation maintenance summarizer. Summarize only the supplied transcript for a future coding-agent turn. Preserve user requests, decisions, current work, unresolved errors, exact identifiers, file paths, and tool call/result pairings. Do not invent facts, call tools, modify files, or address the user. Old attachments are metadata only. Return a concise plain-text summary.`;

const buildCompactionSummaryPrompt = (
	serializedMessages: string,
	previousSummary: z.infer<typeof compactionSummarySchema> | undefined,
	focus: string | undefined
): string => {
	const prior = previousSummary
		? `Prior durable summary:\n${previousSummary.text}\n`
		: "";
	return [
		"Summarize this transcript for the next coding-agent request.",
		focus?.trim()
			? `Public focus: ${focus.trim()}`
			: "Use the default preservation priorities.",
		prior,
		"Transcript:",
		serializedMessages,
	].join("\n");
};

const isKillSwitched = (providerId: string, modelId: string) =>
	billingConfig.providerKillSwitches.has(providerId) ||
	billingConfig.modelKillSwitches.has(modelId);

const getStringTokenEstimate = (value: string): number =>
	Math.ceil(Buffer.byteLength(value, "utf8") / estimatedUtf8BytesPerToken);

const getMessageContextTokenEstimate = (
	messages: z.infer<typeof uiMessageInputSchema>[]
) => {
	const serialized =
		JSON.stringify(
			messages.map((message) => {
				if (!message.metadata || typeof message.metadata !== "object") {
					return message;
				}
				const { skill: _skill, ...metadata } = message.metadata;
				return { ...message, metadata };
			})
		) ?? "";
	return getStringTokenEstimate(serialized) + conservativeInputHeadroomTokens;
};

const getFundedContextTokenEstimate = ({
	agent,
	messages,
	skill,
	skillTool,
}: Pick<
	z.infer<typeof chatRequestSchema>,
	"agent" | "messages" | "skill" | "skillTool"
>) =>
	getMessageContextTokenEstimate(messages) +
	getStringTokenEstimate(getSystemInstructionsForAgent(agent.instructions)) +
	getStringTokenEstimate(
		JSON.stringify(
			agent.visibleCodingTools.map((name) => ({
				description: codingToolDefinitions[name].description,
				inputSchema:
					name === "edit"
						? editModelInputJsonSchema
						: z.toJSONSchema(codingToolDefinitions[name].inputSchema, {
								io: "input",
							}),
				name,
			}))
		)
	) +
	getStringTokenEstimate(JSON.stringify(agent.mcpTools)) +
	(skill ? getStringTokenEstimate(formatSkillUserContext(skill)) : 0) +
	(skillTool ? getStringTokenEstimate(skillTool.description) : 0);

const hasOnlyTextParts = (messages: z.infer<typeof uiMessageInputSchema>[]) =>
	messages
		.filter((message) => message.role === "user")
		.every((message) => message.parts.every((part) => part.type === "text"));

const isAcceptableInput = (
	request: Pick<
		z.infer<typeof chatRequestSchema>,
		"agent" | "messages" | "skill" | "skillTool"
	>,
	inputTokenLimit: number
): boolean =>
	hasOnlyTextParts(request.messages) &&
	getFundedContextTokenEstimate(request) <= inputTokenLimit;

export type SessionsRouteDeps = {
	readonly codingServerTools?: typeof codingServerTools;
	readonly createCodingAgentStreamResponse?: typeof createCodingAgentStreamResponse;
	readonly generateText?: typeof generateText;
	readonly getBillingConfig?: typeof getBillingConfig;
	readonly getBillingRepository?: () => BillingRepository | null;
	readonly resolveSupportedChatModel?: typeof resolveSupportedChatModel;
	readonly resolveWincodeChatModelSelection?: typeof resolveWincodeChatModelSelection;
};

let resolvedBillingRepository: BillingRepository | null | undefined;

const createResolvedBillingRepository = (): BillingRepository | null => {
	if (resolvedBillingRepository !== undefined) {
		return resolvedBillingRepository;
	}
	const billingConfig = getBillingConfig();
	if (
		!billingConfig ||
		(billingConfig.mode !== "allowlist-shadow" &&
			billingConfig.mode !== "canary-enforce" &&
			billingConfig.mode !== "enforce") ||
		billingConfig.priceBookVersion === undefined ||
		billingConfig.priceBookEffectiveDate === undefined ||
		billingConfig.dailyGlobalCostCapUsdMicros === undefined ||
		billingConfig.fundedRequestInputTokenLimit === undefined ||
		billingConfig.fundedRequestOutputTokenLimit === undefined ||
		billingConfig.fundedRequestStepLimit === undefined ||
		billingConfig.fundedRequestTimeWindowSeconds === undefined ||
		((billingConfig.mode === "canary-enforce" ||
			billingConfig.mode === "enforce") &&
			(billingConfig.goProductId === undefined ||
				billingConfig.goRollingQuotaUsdMicros === undefined))
	) {
		resolvedBillingRepository = null;
		return resolvedBillingRepository;
	}
	resolvedBillingRepository = createBillingRepository(createDrizzleClient(), {
		alphaUserAllowlist: billingConfig.alphaUserAllowlist,
		dailyGlobalCostCapUsdMicros: billingConfig.dailyGlobalCostCapUsdMicros,
		fundedRequestInputTokenLimit: billingConfig.fundedRequestInputTokenLimit,
		fundedRequestOutputTokenLimit: billingConfig.fundedRequestOutputTokenLimit,
		fundedRequestStepLimit: billingConfig.fundedRequestStepLimit,
		fundedRequestTimeWindowSeconds:
			billingConfig.fundedRequestTimeWindowSeconds,
		goProductId: billingConfig.goProductId ?? "",
		goRollingQuotaUsdMicros: billingConfig.goRollingQuotaUsdMicros ?? 0n,
		modelKillSwitches: billingConfig.modelKillSwitches,
		mode: billingConfig.mode,
		priceBookEffectiveAt: new Date(
			`${billingConfig.priceBookEffectiveDate}T00:00:00.000Z`
		),
		priceBookVersion: billingConfig.priceBookVersion,
		providerKillSwitches: billingConfig.providerKillSwitches,
	});
	return resolvedBillingRepository;
};

const handleCompactionSummaryRequest = async (
	c: Context,
	generateTextResolved: typeof generateText,
	resolveSupportedChatModelResolved: typeof resolveSupportedChatModel,
	resolveWincodeChatModelSelectionResolved: typeof resolveWincodeChatModelSelection
): Promise<Response> => {
	const subject = await verifyBearerAuth(c.req.header("authorization") ?? null);
	if (!subject) {
		return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
	}
	if (!requireScope(subject, "chat:write")) {
		return c.json({ error: "Forbidden" }, 403);
	}
	if (!hasValidContentLength(c.req.header("content-length") ?? null)) {
		return badRequest();
	}

	let body: unknown;
	try {
		body = await readBoundedJsonBody(c.req.raw);
	} catch {
		return badRequest();
	}
	const parsed = compactionSummaryRequestSchema.safeParse(body);
	if (!parsed.success) {
		return badRequest();
	}

	let resolvedModel: ResolvedModel;
	try {
		const selected = resolveWincodeChatModelSelectionResolved(
			parsed.data.model
		);
		resolvedModel = resolveSupportedChatModelResolved(selected, {
			maxOutputTokens: 4096,
			variant: parsed.data.variant,
		});
	} catch {
		return badRequest();
	}

	try {
		const result = await generateTextResolved({
			abortSignal: c.req.raw.signal,
			maxOutputTokens: 4096,
			maxRetries: 0,
			model: resolvedModel.model,
			prompt: buildCompactionSummaryPrompt(
				parsed.data.serializedMessages,
				parsed.data.previousSummary,
				parsed.data.focus
			),
			providerOptions: resolvedModel.providerOptions,
			system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
		});
		const usage = toCodingMessageUsage(result.usage);
		return new Response(
			JSON.stringify({
				text: result.text,
				...(usage ? { usage } : {}),
			}),
			{
				headers: { "content-type": "application/json; charset=utf-8" },
				status: 200,
			}
		);
	} catch (error) {
		return new Response(
			JSON.stringify({ error: getProviderErrorMessage(error) }),
			{
				headers: { "content-type": "application/json; charset=utf-8" },
				status: 502,
			}
		);
	}
};

const handleChatRequest = async (
	c: Context,
	resolveBillingConfig: typeof getBillingConfig,
	resolveBillingRepository: () => BillingRepository | null,
	deps: Required<
		Pick<
			SessionsRouteDeps,
			| "codingServerTools"
			| "createCodingAgentStreamResponse"
			| "resolveSupportedChatModel"
			| "resolveWincodeChatModelSelection"
		>
	>
) => {
	const subject = await verifyBearerAuth(c.req.header("authorization") ?? null);
	if (!subject) {
		return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
	}
	if (!requireScope(subject, "chat:write")) {
		return c.json({ error: "Forbidden" }, 403);
	}
	if (!hasValidContentLength(c.req.header("content-length") ?? null)) {
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

	const { agent, messages, model, sendReasoning, skill, skillTool, variant } =
		parsed.data;
	const billingConfig = resolveBillingConfig();
	if (
		billingConfig === null ||
		(billingConfig.mode !== "allowlist-shadow" &&
			billingConfig.mode !== "canary-enforce" &&
			billingConfig.mode !== "enforce")
	) {
		return new Response(JSON.stringify({ error: "Billing unavailable" }), {
			headers: { "content-type": "application/json; charset=utf-8" },
			status: 503,
		});
	}
	if (
		billingConfig.fundedRequestInputTokenLimit === undefined ||
		billingConfig.fundedRequestOutputTokenLimit === undefined ||
		billingConfig.fundedRequestStepLimit === undefined ||
		billingConfig.fundedRequestTimeWindowSeconds === undefined
	) {
		return new Response(JSON.stringify({ error: "Billing unavailable" }), {
			headers: { "content-type": "application/json; charset=utf-8" },
			status: 503,
		});
	}
	let resolvedModel: ResolvedModel;
	let resolvedSelection: ReturnType<typeof resolveWincodeChatModelSelection>;
	try {
		resolvedSelection = deps.resolveWincodeChatModelSelection(model);
		const fundedMaxOutputTokens = Number(
			billingConfig.fundedRequestOutputTokenLimit
		);
		resolvedModel = deps.resolveSupportedChatModel(resolvedSelection, {
			maxOutputTokens: fundedMaxOutputTokens,
			variant,
		});
	} catch {
		return badRequest();
	}

	const modelSelection = {
		modelId: resolvedSelection.id,
		providerId: "wincode",
	};
	const billingRuntimeSelection = {
		modelId: resolvedSelection.id,
		providerId: resolvedSelection.provider,
	};
	const fundedInputTokenBudget = Math.min(
		Number(billingConfig.fundedRequestInputTokenLimit),
		conservativeHardInputTokenLimit
	);
	if (!isAcceptableInput({ agent, messages, skill }, fundedInputTokenBudget)) {
		return badRequest();
	}
	if (isKillSwitched(modelSelection.providerId, modelSelection.modelId)) {
		return forbidden("Billing disabled for model/provider");
	}

	const stagedMessages = messages.map((message) =>
		withChatMetadata(message, modelSelection, variant)
	);

	const validation = await safeValidateUIMessages<CodingAgentUIMessage>({
		dataSchemas: codingAgentDataSchemas,
		messages: stagedMessages,
		tools: {
			...deps.codingServerTools,
			...convertMcpToolManifest(agent.mcpTools),
		},
	});
	if (!validation.success) {
		return badRequest();
	}

	const requestTimeoutMs =
		Number(billingConfig.fundedRequestTimeWindowSeconds) * 1000;
	const fundedMaxOutputTokens = Number(
		billingConfig.fundedRequestOutputTokenLimit
	);
	const fundedMaxSteps = Number(billingConfig.fundedRequestStepLimit);
	const boundedMaxOutputTokens = resolvedModel.maxOutputTokens
		? Math.min(resolvedModel.maxOutputTokens, fundedMaxOutputTokens)
		: fundedMaxOutputTokens;
	const abortSignal = AbortSignal.timeout(requestTimeoutMs);

	const lifecycle = createBillingLifecycle({
		config: billingConfig,
		repository: resolveBillingRepository(),
		mode: agent.billingKind,
		requestId: `${c.req.param("id")}:${crypto.randomUUID()}`,
		runtimeModel: billingRuntimeSelection.modelId,
		runtimeProvider: billingRuntimeSelection.providerId,
		startedAt: new Date(),
		userId: subject.userId,
	});
	const reservation = await lifecycle.reserve();
	if (!reservation) {
		return forbidden("Billing reserve denied");
	}
	if (reservation.ok === false) {
		return forbidden(billingReserveDeniedMessage(reservation.reason));
	}

	return deps.createCodingAgentStreamResponse({
		model: resolvedModel.model,
		modelId: resolvedModel.modelId,
		maxOutputTokens: boundedMaxOutputTokens,
		maxSteps: fundedMaxSteps,
		resolvedAgent: {
			instructions: agent.instructions,
			visibleCodingTools: agent.visibleCodingTools,
		},
		abortSignal,
		providerOptions: resolvedModel.providerOptions,
		skill,
		skillTool,
		sendReasoning,
		mcpTools: agent.mcpTools,
		uiMessages: validation.data,
		onEnd: lifecycle.onEnd,
		onStepEnd: lifecycle.onStepEnd,
		onFinish: async () => undefined,
	});
};

export const createSessionsRoutes = (deps: SessionsRouteDeps = {}) => {
	const codingServerToolsResolved = deps.codingServerTools ?? codingServerTools;
	const createCodingAgentStreamResponseResolved =
		deps.createCodingAgentStreamResponse ?? createCodingAgentStreamResponse;
	const generateTextResolved = deps.generateText ?? generateText;
	const resolveBillingConfig = deps.getBillingConfig ?? getBillingConfig;
	const resolveBillingRepository =
		deps.getBillingRepository ?? createResolvedBillingRepository;
	const resolveSupportedChatModelResolved =
		deps.resolveSupportedChatModel ?? resolveSupportedChatModel;
	const resolveWincodeChatModelSelectionResolved =
		deps.resolveWincodeChatModelSelection ?? resolveWincodeChatModelSelection;
	return new Hono()
		.post("/:id/chat", (c) =>
			handleChatRequest(c, resolveBillingConfig, resolveBillingRepository, {
				codingServerTools: codingServerToolsResolved,
				createCodingAgentStreamResponse:
					createCodingAgentStreamResponseResolved,
				resolveSupportedChatModel: resolveSupportedChatModelResolved,
				resolveWincodeChatModelSelection:
					resolveWincodeChatModelSelectionResolved,
			})
		)
		.post("/:id/compact-summary", (c) =>
			handleCompactionSummaryRequest(
				c,
				generateTextResolved,
				resolveSupportedChatModelResolved,
				resolveWincodeChatModelSelectionResolved
			)
		);
};

export const sessionsRoutes = createSessionsRoutes();
