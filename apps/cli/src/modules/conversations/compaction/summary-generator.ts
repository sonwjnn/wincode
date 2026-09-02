import type { ChatModelSelection, ModelVariant } from "@wincode/ai/models";
import {
	type ResolvedModel,
	resolveAiSdkModelTarget,
} from "@wincode/ai/server";
import { normalizeModelUsage } from "@wincode/ai/usage";
import {
	convertToModelMessages,
	generateText,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
} from "ai";
import type { Connections } from "@/modules/connections";
import { resolveChatModelTarget } from "../../model-target";
import type { SummaryGenerator, SummaryGeneratorInput } from "./types";

type ProviderOptions = NonNullable<ResolvedModel["providerOptions"]>;

const MAX_SUMMARY_OUTPUT_TOKENS = 4096;

export const COMPACTION_SUMMARY_SYSTEM_PROMPT = `You are Wincode's conversation maintenance summarizer. Summarize only the supplied transcript for a future coding-agent turn. Preserve user requests, decisions, current work, unresolved errors, exact identifiers, file paths, and tool call/result pairings. Current-window attachments may be inspected when supplied; historical attachments are metadata only. Never reproduce attachment payloads. Return a concise plain-text summary.`;

export type SummaryTextGenerationOptions = {
	abortSignal?: AbortSignal;
	maxOutputTokens: number;
	maxRetries: number;
	messages?: ModelMessage[];
	model: LanguageModel;
	prompt?: string;
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
	signal?: AbortSignal,
	variant?: ModelVariant
) => Promise<SummaryModel>;

const defaultTextGenerator: SummaryTextGenerator = async (options) => {
	const result = await generateText({
		abortSignal: options.abortSignal,
		maxOutputTokens: options.maxOutputTokens,
		maxRetries: options.maxRetries,
		model: options.model,
		providerOptions: options.providerOptions,
		system: options.system,
		...(options.messages
			? { messages: options.messages }
			: { prompt: options.prompt ?? "" }),
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
		...(input.summaryMessages ? [] : ["Transcript:", input.serializedMessages]),
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
		const resolved =
			input.variant === undefined
				? await resolveModel(input.model, input.signal)
				: await resolveModel(input.model, input.signal, input.variant);
		const prompt = buildSummaryPrompt(input);
		const modelMessages = input.summaryMessages
			? await convertToModelMessages(
					input.summaryMessages.map(({ id: _id, ...message }) => message)
				)
			: undefined;
		const generated = await generate({
			abortSignal: input.signal,
			maxOutputTokens: MAX_SUMMARY_OUTPUT_TOKENS,
			maxRetries: 0,
			model: resolved.model,
			...(modelMessages
				? {
						messages: [
							{ content: prompt, role: "user" as const },
							...modelMessages,
						],
					}
				: { prompt }),
			providerOptions: resolved.providerOptions,
			system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
		});
		const usage = normalizeModelUsage(generated.usage);
		return {
			text: generated.text,
			...(usage ? { usage } : {}),
		};
	};

export const resolveDirectSummaryModel = async (
	selection: ChatModelSelection,
	connections: Connections,
	signal?: AbortSignal,
	variant?: ModelVariant
): Promise<SummaryModel> => {
	const target = await resolveChatModelTarget(selection, connections, {
		signal,
		variant,
	});
	const resolved = resolveAiSdkModelTarget(target);
	return {
		model: resolved.model,
		...(resolved.providerOptions
			? { providerOptions: resolved.providerOptions }
			: {}),
	};
};

export const createDirectSummaryGenerator = (
	connections: Connections,
	generate?: SummaryTextGenerator
): SummaryGenerator =>
	createLanguageModelSummaryGenerator({
		generate,
		resolveModel: (selection, signal, variant) =>
			resolveDirectSummaryModel(selection, connections, signal, variant),
	});
