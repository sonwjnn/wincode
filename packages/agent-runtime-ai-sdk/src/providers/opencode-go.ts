import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { resolveModelProviderOptions } from "@wincode/ai/model-provider-options";
import type { SupportedChatModel } from "@wincode/ai/models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
	toAiSdkProviderOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "opencode-go" }>;
const ZEN_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ENV_KEY = "OPENCODE_GO_API_KEY";

const resolve = (
	model: Model,
	apiKey: string | undefined,
	options: ResolverOptions
): ResolvedModel => {
	const resolvedOptions = resolveModelProviderOptions(model, options);
	const base = {
		modelId: model.id,
		provider: "opencode-go" as const,
		...(resolvedOptions.providerOptions
			? {
					providerOptions: toAiSdkProviderOptions(
						resolvedOptions.providerOptions
					),
				}
			: {}),
		...(resolvedOptions.maxOutputTokens === undefined
			? {}
			: { maxOutputTokens: resolvedOptions.maxOutputTokens }),
	};
	switch (model.sdk) {
		case "openai":
			return {
				...base,
				model: createOpenAI({
					apiKey,
					baseURL: ZEN_GO_BASE_URL,
				}).responses(model.id),
			};
		case "anthropic":
			return {
				...base,
				model: createAnthropic({
					apiKey,
					baseURL: ZEN_GO_BASE_URL,
				})(model.id),
			};
		case "openai-compatible":
			return {
				...base,
				model: createOpenAICompatible({
					name: "opencode-go",
					apiKey,
					baseURL: ZEN_GO_BASE_URL,
				})(model.id),
			};
		default:
			throw new Error("Unsupported OpenCode Go model");
	}
};

export const openCodeGoResolver = defineModelResolver(
	"opencode-go",
	(model): model is Model => model.provider === "opencode-go",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolve(model, apiKey, options),
		resolveWithEnvironment: (model, options) =>
			resolve(model, process.env[OPENCODE_GO_ENV_KEY], options),
	}
);
