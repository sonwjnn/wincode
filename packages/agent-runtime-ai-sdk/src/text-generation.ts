import type { ModelTarget } from "@wincode/ai/model-target";
import { type ModelUsage, normalizeModelUsage } from "@wincode/ai/model-usage";
import { isNull, isUndefined } from "@wincode/runtime-utils";
import { streamText } from "ai";
import type { RequireOneOrNone } from "type-fest";
import { resolveAiSdkModelTarget } from "./model-resolver";

export type RuntimePromptMessage = {
	readonly content: string;
	readonly role: "assistant" | "user";
};

export type RuntimePromptSource = RequireOneOrNone<
	{
		readonly messages: readonly RuntimePromptMessage[];
		readonly prompt: string;
	},
	"messages" | "prompt"
>;

export type AiSdkTextGenerationOptions = {
	readonly abortSignal?: AbortSignal;
	readonly maxOutputTokens: number;
	readonly maxRetries: number;
	readonly model: ModelTarget;
	readonly system: string;
} & RuntimePromptSource;

export type AiSdkTextGenerationResult = {
	readonly text: string;
	readonly usage?: ModelUsage;
};

export const generateAiSdkText = async (
	options: AiSdkTextGenerationOptions
): Promise<AiSdkTextGenerationResult> => {
	const resolved = resolveAiSdkModelTarget(options.model);
	// ChatGPT's Codex OAuth endpoint rejects the Responses API max_output_tokens field.
	const supportsOutputLimit = options.model.authorization.kind !== "oauth";
	// Override AI SDK's default handler so raw provider errors and headers are never logged.
	const result = streamText({
		abortSignal: options.abortSignal,
		maxRetries: options.maxRetries,
		model: resolved.model,
		onError: () => undefined,
		providerOptions: resolved.providerOptions,
		system: options.system,
		...(supportsOutputLimit
			? { maxOutputTokens: options.maxOutputTokens }
			: {}),
		...(isUndefined(options.messages)
			? { prompt: options.prompt ?? "" }
			: { messages: [...options.messages] }),
	});
	let streamError: unknown;
	let receivedStreamError = false;
	await result.consumeStream({
		onError: (error) => {
			streamError = error;
			receivedStreamError = true;
		},
	});
	if (receivedStreamError) {
		throw streamError;
	}
	const text = await result.text;
	const usage = normalizeModelUsage(await result.usage);
	return isNull(usage) ? { text } : { text, usage };
};
