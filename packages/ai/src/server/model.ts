import { devToolsMiddleware } from "@ai-sdk/devtools";
import { openai } from "@ai-sdk/openai";
import { type LanguageModel, wrapLanguageModel } from "ai";

const baseModel = openai("gpt-5.4-mini");

export const codingModel: LanguageModel =
	process.env.NODE_ENV === "production"
		? baseModel
		: wrapLanguageModel({
				model: baseModel,
				middleware: devToolsMiddleware(),
			});

export const codingProviderOptions = {
	anthropic: {
		thinking: { type: "adaptive" },
	},
	google: {
		thinkingConfig: { includeThoughts: true },
	},
	openai: {
		reasoningSummary: "detailed",
	},
};
