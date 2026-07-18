import { anthropic, createAnthropic } from "@ai-sdk/anthropic";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { ModelVariant, SupportedChatModel } from "../../models";
import { normalizeModelVariant } from "../../models";
import {
	defineModelResolver,
	type ResolvedModel,
	type ResolverOptions,
} from "./contract";

type Model = Extract<SupportedChatModel, { provider: "anthropic" }>;
const MAX = 32_000;
const adaptive = new Set<Model["id"]>([
	"claude-opus-4-7",
	"claude-sonnet-5",
	"claude-opus-4-8",
	"claude-fable-5",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
]);
const manual = new Set<Model["id"]>([
	"claude-opus-4-5",
	"claude-opus-4-5-20251101",
]);
const budgets: Partial<Record<Model["id"], readonly [number, number]>> = {
	"claude-haiku-4-5": [16_000, 31_999],
	"claude-haiku-4-5-20251001": [16_000, 31_999],
	"claude-sonnet-4-5": [16_000, 31_999],
	"claude-sonnet-4-5-20250929": [16_000, 31_999],
};
const options = (
	model: Model,
	variant: ModelVariant | undefined,
	maxOutputTokens?: number
): ProviderOptions | undefined => {
	const v = normalizeModelVariant(
		{ modelId: model.id, providerId: model.connectionProviderId },
		variant
	);
	if (variant === undefined) {
		return;
	}
	if (!v) {
		throw new Error(
			`Unsupported model variant: anthropic/${model.id}/${variant}`
		);
	}
	if (adaptive.has(model.id)) {
		return { anthropic: { effort: v, thinking: { type: "adaptive" } } };
	}
	const budget = manual.has(model.id) ? [16_000, 16_000] : budgets[model.id];
	if (manual.has(model.id)) {
		const max = Math.min(maxOutputTokens ?? MAX, MAX);
		if (max <= 16_000) {
			throw new Error(
				`Invalid Anthropic budget for ${model.id}: 16000 must be less than ${max}`
			);
		}
		return {
			anthropic: {
				effort: v,
				thinking: { type: "enabled", budgetTokens: 16_000 },
			},
		};
	}
	if (!budget || (v !== "high" && v !== "max")) {
		throw new Error(
			`Unsupported model variant: anthropic/${model.id}/${variant}`
		);
	}
	const max = Math.min(maxOutputTokens ?? MAX, MAX);
	const selectedBudget = budget[v === "high" ? 0 : 1];
	if (selectedBudget >= max) {
		throw new Error(
			`Invalid Anthropic budget for ${model.id}: ${selectedBudget} must be less than ${max}`
		);
	}
	return {
		anthropic: {
			thinking: { type: "enabled", budgetTokens: selectedBudget },
		},
	};
};
const resolve = (
	model: Model,
	provider: ReturnType<typeof createAnthropic>,
	opts: ResolverOptions
): ResolvedModel => ({
	model: provider(model.id),
	modelId: model.id,
	provider: "anthropic",
	providerOptions: options(model, opts.variant, opts.maxOutputTokens),
	maxOutputTokens:
		opts.variant && (manual.has(model.id) || model.id in budgets)
			? Math.min(opts.maxOutputTokens ?? MAX, MAX)
			: undefined,
});
export const anthropicResolver = defineModelResolver(
	"anthropic",
	(m): m is Model => m.provider === "anthropic",
	{
		resolveWithApiKey: (m, key, opts) =>
			resolve(m, createAnthropic({ apiKey: key }), opts),
		resolveWithEnvironment: (m, opts) => resolve(m, anthropic, opts),
	}
);
