import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	type ChatModelSelection,
	type CodingMessageUsage,
	getChatModelRoute,
	toCodingMessageUsage,
} from "@wincode/ai";
import {
	resolveDirectChatModel,
	resolveOpenAIChatModel,
} from "@wincode/ai/server";
import { generateText, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import type { Connections } from "@/modules/connections";
import { getServerUrl } from "@/shared/api/hono-client";
import type {
	SummaryGenerator,
	SummaryGeneratorInput,
	SummaryGeneratorResult,
} from "./types";

export const COMPACTION_SUMMARY_SYSTEM_PROMPT = `You are Wincode's conversation maintenance summarizer. Summarize only the supplied transcript for a future coding-agent turn. Preserve user requests, decisions, current work, unresolved errors, exact identifiers, file paths, and tool call/result pairings. Do not invent facts, call tools, modify files, or address the user. Old attachments are metadata only. Return a concise plain-text summary.`;

const MAX_SUMMARY_OUTPUT_TOKENS = 4096;

export type SummaryTextGenerationOptions = {
	abortSignal?: AbortSignal;
	maxOutputTokens: number;
	maxRetries: number;
	model: LanguageModel;
	prompt: string;
	providerOptions?: ProviderOptions;
	system: string;
};

export type SummaryTextGenerator = (
	options: SummaryTextGenerationOptions
) => Promise<{ text: string; usage?: LanguageModelUsage }>;

export type SummaryModel = {
	model: LanguageModel;
	providerOptions?: ProviderOptions;
};

export type SummaryModelResolver = (
	selection: ChatModelSelection,
	signal?: AbortSignal
) => Promise<SummaryModel>;

const defaultTextGenerator: SummaryTextGenerator = async (options) => {
	const result = await generateText({
		abortSignal: options.abortSignal,
		maxOutputTokens: options.maxOutputTokens,
		maxRetries: options.maxRetries,
		model: options.model,
		prompt: options.prompt,
		providerOptions: options.providerOptions,
		system: options.system,
	});
	return { text: result.text, usage: result.usage };
};

const buildSummaryPrompt = (input: SummaryGeneratorInput): string => {
	const focus = input.focus?.trim();
	const prior = input.previousSummary
		? `\nPrior durable summary:\n${input.previousSummary.text}\n`
		: "";
	return [
		"Summarize this transcript for the next coding-agent request.",
		focus
			? `Public focus: ${focus}`
			: "Use the default preservation priorities.",
		prior,
		"Transcript:",
		input.serializedMessages,
	].join("\n");
};

export const createLanguageModelSummaryGenerator =
	({
		resolveModel,
		generate = defaultTextGenerator,
	}: {
		resolveModel: SummaryModelResolver;
		generate?: SummaryTextGenerator;
	}): SummaryGenerator =>
	async (input) => {
		const resolved = await resolveModel(input.model, input.signal);
		const generated = await generate({
			abortSignal: input.signal,
			maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
			maxRetries: 0,
			model: resolved.model,
			prompt: buildSummaryPrompt(input),
			providerOptions: resolved.providerOptions,
			system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
		});
		const usage = toCodingMessageUsage(generated.usage);
		return {
			text: generated.text,
			...(usage ? { usage } : {}),
		};
	};

const getBearerToken = (
	authorization:
		| { kind: "api-key"; apiKey: string }
		| { kind: "bearer"; token: string }
): string =>
	authorization.kind === "bearer" ? authorization.token : authorization.apiKey;

export const resolveDirectSummaryModel = async (
	selection: ChatModelSelection,
	connections: Connections,
	signal?: AbortSignal
): Promise<SummaryModel> => {
	const authorization = await connections.authorize(
		selection.providerId,
		signal
	);
	if (authorization.kind === "api-key") {
		const resolved = resolveDirectChatModel(selection, authorization.apiKey);
		return {
			model: resolved.model,
			...(resolved.providerOptions
				? { providerOptions: resolved.providerOptions }
				: {}),
		};
	}
	if (authorization.kind === "oauth" && selection.providerId === "openai") {
		const resolved = resolveOpenAIChatModel(selection.modelId, {
			accessToken: authorization.accessToken,
			accountId: authorization.accountId,
			originator: "wincode",
		});
		return {
			model: resolved.model,
			...(resolved.providerOptions
				? { providerOptions: resolved.providerOptions }
				: {}),
		};
	}
	throw new Error(
		"Compaction requires supported direct-provider authorization."
	);
};

export const createDirectSummaryGenerator = (
	connections: Connections,
	generate?: SummaryTextGenerator
): SummaryGenerator =>
	createLanguageModelSummaryGenerator({
		generate,
		resolveModel: (selection, signal) =>
			resolveDirectSummaryModel(selection, connections, signal),
	});

const summaryResponseSchema = z
	.object({
		text: z.string(),
		usage: z
			.object({
				cacheReadTokens: z.number().int().nonnegative().optional(),
				cacheWriteTokens: z.number().int().nonnegative().optional(),
				inputTokens: z.number().int().nonnegative(),
				outputTokens: z.number().int().nonnegative(),
				reasoningTokens: z.number().int().nonnegative().optional(),
				totalTokens: z.number().int().nonnegative().optional(),
			})
			.strict()
			.optional(),
	})
	.strict();

export type HostedSummaryGeneratorOptions = {
	fetch?: typeof globalThis.fetch;
	getBaseUrl?: () => string;
	sessionId: string;
	connections: Connections;
};

export const createHostedSummaryGenerator =
	({
		connections,
		fetch: fetchImpl = globalThis.fetch,
		getBaseUrl = getServerUrl,
		sessionId,
	}: HostedSummaryGeneratorOptions): SummaryGenerator =>
	async (input): Promise<SummaryGeneratorResult> => {
		if (getChatModelRoute(input.model) !== "hosted") {
			throw new Error("Hosted compaction requires a hosted model selection.");
		}
		const authorization = await connections.authorize("wincode", input.signal);
		const response = await fetchImpl(
			`${getBaseUrl()}/api/sessions/${encodeURIComponent(sessionId)}/compact-summary`,
			{
				body: JSON.stringify({
					focus: input.focus,
					model: input.model.modelId,
					previousSummary: input.previousSummary,
					serializedMessages: input.serializedMessages,
				}),
				headers: {
					Authorization: `Bearer ${getBearerToken(authorization)}`,
					"Content-Type": "application/json",
				},
				method: "POST",
				signal: input.signal,
			}
		);
		const body = await response.text();
		if (!response.ok) {
			throw new Error(
				body || `Compaction request failed (${response.status}).`
			);
		}
		const parsed = summaryResponseSchema.safeParse(JSON.parse(body));
		if (!parsed.success) {
			throw new Error("Compaction response was invalid.");
		}
		const usage: CodingMessageUsage | null = parsed.data.usage
			? parsed.data.usage
			: null;
		return {
			text: parsed.data.text,
			...(usage ? { usage } : {}),
		};
	};
