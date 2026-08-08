import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { modelVariantsByProviderModel } from "../../generated/model-variants.generated";
import {
	normalizeModelVariantForModel,
	type SupportedChatModel,
} from "../../models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "opencode-go" }>;
const ZEN_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
const OPENCODE_GO_ENV_KEY = "OPENCODE_GO_API_KEY";
const reasoningSummaryModels = new Set<Model["id"]>(["gpt-5.6-luna"]);
const generatedEntry = (model: Model) =>
	modelVariantsByProviderModel[`opencode-go/${model.id}`];
const validateVariantOrThrow = (
	model: Model,
	variant: ResolverOptions["variant"]
) => {
	if (variant !== undefined && !normalizeModelVariantForModel(model, variant)) {
		throw new Error(
			`Unsupported model variant: opencode-go/${model.id}/${variant}`
		);
	}
};
const options = (
	model: Model,
	variant: ResolverOptions["variant"]
): ProviderOptions | undefined => {
	switch (model.sdk) {
		case "openai":
			return {
				openai: {
					store: false,
					...(reasoningSummaryModels.has(model.id)
						? { reasoningSummary: "detailed" }
						: {}),
					...(variant === undefined ? {} : { reasoningEffort: variant }),
				},
			};
		case "anthropic": {
			if (model.id === "minimax-m3") {
				if (variant === "none") {
					return { anthropic: { thinking: { type: "disabled" } } };
				}
				if (variant === "thinking") {
					return { anthropic: { thinking: { type: "adaptive" } } };
				}
				return;
			}
			const budget = generatedEntry(model)?.budget;
			if (budget && (variant === "high" || variant === "max")) {
				return {
					anthropic: {
						thinking: { type: "enabled", budgetTokens: budget[variant] },
					},
				};
			}
			return;
		}
		default:
			return;
	}
};
const resolve = (
	model: Model,
	apiKey: string | undefined,
	opts: ResolverOptions
): ResolvedModel => {
	validateVariantOrThrow(model, opts.variant);
	const base = {
		modelId: model.id,
		provider: "opencode-go",
		providerOptions: options(model, opts.variant),
		maxOutputTokens: opts.maxOutputTokens,
	} as const;
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
		resolveWithApiKey: (model, apiKey, opts) => resolve(model, apiKey, opts),
		resolveWithEnvironment: (model, opts) =>
			resolve(model, process.env[OPENCODE_GO_ENV_KEY], opts),
	}
);
