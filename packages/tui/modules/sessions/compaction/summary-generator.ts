import {
	generateAiSdkText,
	type RuntimePromptMessage,
} from "@wincode/agent-runtime-ai-sdk";
import type {
	ChatModelSelection,
	ModelTarget,
	ModelVariant,
} from "@wincode/ai/model";
import type { Connections } from "@/modules/connections";
import { resolveChatModelTarget } from "../../model-target";
import type { SessionMessage } from "../message";
import { serializeMessagesForCompaction } from "./compaction";
import {
	DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS,
	type SummaryGenerator,
	type SummaryGeneratorInput,
	type SummaryGeneratorResult,
} from "./types";

export const COMPACTION_SUMMARY_SYSTEM_PROMPT = `You are Wincode's session maintenance summarizer. Summarize only the supplied transcript for a future coding-agent turn. Preserve user requests, decisions, current work, unresolved errors, exact identifiers, file paths, and tool call/result pairings. Current-window attachments may be inspected when supplied; historical attachments are metadata only. Never reproduce attachment payloads. Return a concise plain-text summary.`;

export type SummaryTextGenerationOptions = {
	readonly abortSignal?: AbortSignal;
	readonly maxOutputTokens: number;
	readonly maxRetries: number;
	readonly messages?: readonly RuntimePromptMessage[];
	readonly model: ModelTarget;
	readonly prompt?: string;
	readonly system: string;
};

export type SummaryTextGenerator = (
	options: SummaryTextGenerationOptions
) => Promise<SummaryGeneratorResult>;

export type SummaryModel = ModelTarget;

export type SummaryModelResolver = (
	selection: ChatModelSelection,
	signal?: AbortSignal,
	variant?: ModelVariant,
	maxOutputTokens?: number
) => Promise<SummaryModel>;
const defaultTextGenerator: SummaryTextGenerator = async (options) =>
	generateAiSdkText(options);

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

const summaryPromptMessages = (
	messages: readonly SessionMessage[]
): RuntimePromptMessage[] =>
	messages.flatMap((message) => {
		if (message.role === "system") {
			return [];
		}
		const role = message.role === "assistant" ? "assistant" : "user";
		const content = serializeMessagesForCompaction([message]);
		return content.length === 0 ? [] : [{ content, role }];
	});

export const createLanguageModelSummaryGenerator =
	({
		generate = defaultTextGenerator,
		resolveModel,
	}: {
		generate?: SummaryTextGenerator;
		resolveModel: SummaryModelResolver;
	}): SummaryGenerator =>
	async (input) => {
		const requestedOutputTokens = Math.max(
			1,
			Math.floor(
				input.maxOutputTokens ?? DEFAULT_COMPACTION_SUMMARY_OUTPUT_TOKENS
			)
		);
		const model = await resolveModel(
			input.model,
			input.signal,
			input.variant,
			requestedOutputTokens
		);
		const maxOutputTokens = Math.min(
			requestedOutputTokens,
			model.maxOutputTokens ?? requestedOutputTokens
		);
		const prompt = buildSummaryPrompt(input);
		const messages = input.summaryMessages
			? [
					{ content: prompt, role: "user" as const },
					...summaryPromptMessages(input.summaryMessages),
				]
			: undefined;
		return generate({
			abortSignal: input.signal,
			maxOutputTokens,
			maxRetries: 0,
			model,
			...(messages === undefined ? { prompt } : { messages }),
			system: COMPACTION_SUMMARY_SYSTEM_PROMPT,
		});
	};

export const resolveDirectSummaryModel = async (
	selection: ChatModelSelection,
	connections: Connections,
	signal?: AbortSignal,
	variant?: ModelVariant,
	maxOutputTokens?: number
): Promise<SummaryModel> =>
	resolveChatModelTarget(selection, connections, {
		allowRetired: true,
		...(signal === undefined ? {} : { signal }),
		...(variant === undefined ? {} : { variant }),
		...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
	});
export const createDirectSummaryGenerator = (
	connections: Connections,
	generate?: SummaryTextGenerator
): SummaryGenerator =>
	createLanguageModelSummaryGenerator({
		generate,
		resolveModel: (selection, signal, variant, maxOutputTokens) =>
			resolveDirectSummaryModel(
				selection,
				connections,
				signal,
				variant,
				maxOutputTokens
			),
	});
