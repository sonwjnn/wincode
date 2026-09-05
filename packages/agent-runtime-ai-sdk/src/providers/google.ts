import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import type { SupportedChatModel } from "@wincode/ai/models";
import { defineModelResolver, resolveModelWithProvider } from "./contract";

type Model = Extract<SupportedChatModel, { provider: "google" }>;

export const googleResolver = defineModelResolver(
	"google",
	(model): model is Model => model.provider === "google",
	{
		resolveWithApiKey: (model, apiKey, options) =>
			resolveModelWithProvider(
				model,
				createGoogleGenerativeAI({ apiKey }),
				options
			),
		resolveWithEnvironment: (model, options) =>
			resolveModelWithProvider(model, google, options),
	}
);
