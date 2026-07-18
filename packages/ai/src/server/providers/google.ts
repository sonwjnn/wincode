import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import {
	normalizeModelVariantForModel,
	type SupportedChatModel,
} from "../../models";
import { defineModelResolver } from "./contract";

type Model = Extract<SupportedChatModel, { provider: "google" }>;
const levels = new Set<Model["id"]>([
	"gemini-3.1-flash-lite",
	"gemini-3.5-flash",
	"gemini-3-flash-preview",
	"gemini-3.1-pro-preview",
	"gemini-3-pro-preview",
]);
const budgets: Partial<Record<Model["id"], readonly [number, number]>> = {
	"gemini-2.5-pro": [16_000, 31_999],
	"gemini-2.5-flash": [12_288, 24_576],
	"gemini-flash-latest": [12_288, 24_576],
	"gemini-flash-lite-latest": [12_288, 24_576],
	"gemini-2.5-flash-lite": [12_288, 24_576],
};
const options = (
	m: Model,
	variant: string | undefined,
	max?: number
): ProviderOptions | undefined => {
	const v = normalizeModelVariantForModel(m, variant);
	if (variant === undefined) {
		return;
	}
	if (!v) {
		throw new Error(`Unsupported model variant: google/${m.id}/${variant}`);
	}
	if (levels.has(m.id)) {
		return { google: { thinkingConfig: { thinkingLevel: v } } };
	}
	const budget = budgets[m.id];
	if (!budget || (v !== "high" && v !== "max")) {
		throw new Error(`Unsupported model variant: google/${m.id}/${variant}`);
	}
	const limit = Math.min(max ?? 32_000, 32_000);
	const selectedBudget = budget[v === "high" ? 0 : 1];
	if (selectedBudget >= limit) {
		throw new Error(
			`Invalid Google budget for ${m.id}: ${selectedBudget} must be less than ${limit}`
		);
	}
	return { google: { thinkingConfig: { thinkingBudget: selectedBudget } } };
};
export const googleResolver = defineModelResolver(
	"google",
	(m): m is Model => m.provider === "google",
	{
		resolveWithApiKey: (m, key, opts) => ({
			model: createGoogleGenerativeAI({ apiKey: key })(m.id),
			modelId: m.id,
			provider: "google",
			providerOptions: options(m, opts.variant, opts.maxOutputTokens),
			maxOutputTokens:
				opts.variant && m.id in budgets
					? Math.min(opts.maxOutputTokens ?? 32_000, 32_000)
					: undefined,
		}),
		resolveWithEnvironment: (m, opts) => ({
			model: google(m.id),
			modelId: m.id,
			provider: "google",
			providerOptions: options(m, opts.variant, opts.maxOutputTokens),
			maxOutputTokens:
				opts.variant && m.id in budgets
					? Math.min(opts.maxOutputTokens ?? 32_000, 32_000)
					: undefined,
		}),
	}
);
