import type { ModelTarget } from "@wincode/ai/model-target";
import { type ModelUsage, normalizeModelUsage } from "@wincode/ai/model-usage";
import { generateText } from "ai";
import { resolveAiSdkModelTarget } from "./model-resolver";

export type RuntimePromptMessage = {
	readonly content: string;
	readonly role: "assistant" | "user";
};

export type AiSdkTextGenerationOptions = {
	readonly abortSignal?: AbortSignal;
	readonly maxOutputTokens: number;
	readonly maxRetries: number;
	readonly messages?: readonly RuntimePromptMessage[];
	readonly model: ModelTarget;
	readonly prompt?: string;
	readonly system: string;
};

export type AiSdkTextGenerationResult = {
	readonly text: string;
	readonly usage?: ModelUsage;
};

export const generateAiSdkText = async (
	options: AiSdkTextGenerationOptions
): Promise<AiSdkTextGenerationResult> => {
	const resolved = resolveAiSdkModelTarget(options.model);
	const result = await generateText({
		abortSignal: options.abortSignal,
		maxOutputTokens: options.maxOutputTokens,
		maxRetries: options.maxRetries,
		model: resolved.model,
		providerOptions: resolved.providerOptions,
		system: options.system,
		...(options.messages === undefined
			? { prompt: options.prompt ?? "" }
			: { messages: [...options.messages] }),
	});
	const usage = normalizeModelUsage(result.usage);
	return usage === null ? { text: result.text } : { text: result.text, usage };
};
