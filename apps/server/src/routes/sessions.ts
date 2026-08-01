import {
	type CodingAgentUIMessage,
	codingAgentDataSchemas,
	codingMessageMetadataSchema,
	codingModeNameSchema,
	formatSkillUserContext,
	mcpToolManifestSchema,
	modelVariantSchema,
	skillContextSchema,
} from "@wincode/ai";
import {
	codingServerTools,
	createCodingAgentStreamResponse,
	createMcpServerTools,
	type ResolvedModel,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
} from "@wincode/ai/server";
import { createDrizzleClient } from "@wincode/db/client";
import { safeValidateUIMessages } from "ai";
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
const conservativeToolPolicyTokens = 256;
const deterministicSystemInstructionTokenOverhead = 128;
const deterministicSystemInstructions = {
	build: `You are a basic coding agent running in a user's CLI.
All file tools are limited to the CLI workspace.

Mode: BUILD.
Purpose: implement requested code changes in the workspace.
Use tools to inspect and modify files before answering about code.
Prefer list, grep, and read before editing. Prefer edit for targeted changes and write for new files or full rewrites.`,
	plan: `You are a basic coding agent running in a user's CLI.
All file tools are limited to the CLI workspace.

Mode: PLAN.
Purpose: read-only analysis and implementation planning.
Do not modify files. Do not write files. Do not call edit or write tools.
Use only read-only inspection tools to understand the workspace.
Return a concrete plan, risks, and verification steps instead of implementing changes.`,
} as const;

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
	skill: skillContextSchema.optional(),
	mcpTools: mcpToolManifestSchema.default([]),
});

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
	mode: z.infer<typeof codingModeNameSchema>,
	model: { modelId: string; providerId: string },
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
	model: { modelId: string; providerId: string },
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

const isKillSwitched = (providerId: string, modelId: string) =>
	billingConfig.providerKillSwitches.has(providerId) ||
	billingConfig.modelKillSwitches.has(modelId);

const getStringTokenEstimate = (value: string): number =>
	Buffer.byteLength(value, "utf8");

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
	return (
		getStringTokenEstimate(serialized) +
		conservativeInputHeadroomTokens +
		conservativeToolPolicyTokens
	);
};

const getDeterministicFundedContextTokenOverhead = (
	mode: z.infer<typeof codingModeNameSchema>
): number =>
	Math.min(
		deterministicSystemInstructionTokenOverhead,
		getStringTokenEstimate(deterministicSystemInstructions[mode])
	);

const hasOnlyTextParts = (messages: z.infer<typeof uiMessageInputSchema>[]) =>
	messages
		.filter((message) => message.role === "user")
		.every((message) => message.parts.every((part) => part.type === "text"));

const isAcceptableInput = (
	messages: z.infer<typeof uiMessageInputSchema>[],
	inputTokenLimit: number
): boolean =>
	hasOnlyTextParts(messages) &&
	getMessageContextTokenEstimate(messages) <= inputTokenLimit;

export type SessionsRouteDeps = {
	readonly codingServerTools?: typeof codingServerTools;
	readonly createCodingAgentStreamResponse?: typeof createCodingAgentStreamResponse;
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
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: request validation and billing gates are intentionally explicit
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

	const { messages, mode, model, sendReasoning, variant, skill, mcpTools } =
		parsed.data;
	if (mode === "plan" && mcpTools.length > 0) {
		return badRequest();
	}
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
	const fundedContextOverhead =
		getDeterministicFundedContextTokenOverhead(mode);
	const fundedInputTokenBudget = Math.max(
		0,
		Math.min(
			Number(billingConfig.fundedRequestInputTokenLimit),
			conservativeHardInputTokenLimit
		) -
			fundedContextOverhead -
			(skill ? getStringTokenEstimate(formatSkillUserContext(skill)) : 0) -
			getStringTokenEstimate(JSON.stringify(mcpTools))
	);
	if (!isAcceptableInput(messages, fundedInputTokenBudget)) {
		return badRequest();
	}
	if (isKillSwitched(modelSelection.providerId, modelSelection.modelId)) {
		return forbidden("Billing disabled for model/provider");
	}

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
		tools: { ...deps.codingServerTools, ...createMcpServerTools(mcpTools) },
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
		mode,
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
		mode,
		abortSignal,
		providerOptions: resolvedModel.providerOptions,
		skill,
		sendReasoning,
		mcpTools,
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
	const resolveBillingConfig = deps.getBillingConfig ?? getBillingConfig;
	const resolveBillingRepository =
		deps.getBillingRepository ?? createResolvedBillingRepository;
	const resolveSupportedChatModelResolved =
		deps.resolveSupportedChatModel ?? resolveSupportedChatModel;
	const resolveWincodeChatModelSelectionResolved =
		deps.resolveWincodeChatModelSelection ?? resolveWincodeChatModelSelection;
	return new Hono().post("/:id/chat", (c) =>
		handleChatRequest(c, resolveBillingConfig, resolveBillingRepository, {
			codingServerTools: codingServerToolsResolved,
			createCodingAgentStreamResponse: createCodingAgentStreamResponseResolved,
			resolveSupportedChatModel: resolveSupportedChatModelResolved,
			resolveWincodeChatModelSelection:
				resolveWincodeChatModelSelectionResolved,
		})
	);
};

export const sessionsRoutes = createSessionsRoutes();
