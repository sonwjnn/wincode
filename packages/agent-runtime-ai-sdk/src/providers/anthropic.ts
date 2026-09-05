import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { SupportedChatModel } from "@wincode/ai/models";
import { defineModelResolver, resolveModelWithProvider } from "./contract";

type Model = Extract<SupportedChatModel, { provider: "anthropic" }>;

export const anthropicResolver = defineModelResolver(
	"anthropic",
	(model): model is Model => model.provider === "anthropic",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolveModelWithProvider(model, createAnthropic({ apiKey }), options),
		resolveWithEnvironment: (model, options) =>
			resolveModelWithProvider(model, anthropic, options),
	}
);
