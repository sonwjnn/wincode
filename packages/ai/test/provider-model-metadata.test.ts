import { expect, test } from "bun:test";
import { fromAny } from "@total-typescript/shoehorn";
import { parsePromptCacheTtlMs } from "../src/model-metadata";
import { withProviderModelMetadata } from "../src/provider-model-metadata";
import type { Provider, ProviderModel } from "../src/sdk";
import { createProviderCollection } from "../src/sdk";
import { createAnthropicProvider } from "../src/sdk-providers/anthropic";
import { createDeepSeekProvider } from "../src/sdk-providers/deepseek";
import { createGoogleProvider } from "../src/sdk-providers/google";
import { createOpenAIProvider } from "../src/sdk-providers/openai";
import { createOpenCodeGoProvider } from "../src/sdk-providers/opencode-go";

const providerFor = (models: readonly ProviderModel[]): Provider => ({
	id: "fixture",
	models,
	resolveAuthorization: () => ({ authorization: "fixture" }),
	async *streamChat() {
		yield { type: "finish" };
	},
});

test("ProviderCollection preserves explicit support metadata and rejects invented values", () => {
	const collection = createProviderCollection();
	collection.register(
		providerFor([
			{
				modelId: "declared",
				promptCacheRetentionTiers: ["short", "long"],
				protocolId: "fixture",
				providerId: "fixture",
				reasoningEfforts: ["off", "high"],
			},
			{
				modelId: "undeclared",
				protocolId: "fixture",
				providerId: "fixture",
			},
		])
	);

	expect(collection.getModel("fixture", "declared")).toMatchObject({
		promptCacheRetentionTiers: ["short", "long"],
		reasoningEfforts: ["off", "high"],
	});
	expect(collection.getModel("fixture", "undeclared")).toEqual({
		modelId: "undeclared",
		protocolId: "fixture",
		providerId: "fixture",
	});

	const invalidCollection = createProviderCollection();
	expect(() =>
		invalidCollection.register(
			providerFor(
				fromAny([
					{
						modelId: "bad-effort",
						protocolId: "fixture",
						providerId: "fixture",
						reasoningEfforts: ["guess"],
					},
				])
			)
		)
	).toThrow("Invalid model identity");
});

test("OpenAI GPT-6 Luna follows its documented direct-API reasoning ladder", () => {
	const model = createOpenAIProvider({
		fetch: async () => new Response(),
	}).models.find((candidate) => candidate.modelId === "gpt-6-luna");
	expect(model?.reasoningEfforts).toEqual([
		"off",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
});

test("first-party Provider Models expose shared defaults and model-specific effort limits", () => {
	const providers = [
		createOpenAIProvider({ fetch: async () => new Response() }),
		createAnthropicProvider({ fetch: async () => new Response() }),
		createDeepSeekProvider(),
		createGoogleProvider({ fetch: async () => new Response() }),
		createOpenCodeGoProvider({ fetch: async () => new Response() }),
	];
	const modelFor = (providerId: string, modelId: string): ProviderModel => {
		const model = providers
			.find((provider) => provider.id === providerId)
			?.models.find((candidate) => candidate.modelId === modelId);
		if (!model) {
			throw new Error(`Missing Provider Model ${providerId}/${modelId}`);
		}
		return model;
	};

	expect(modelFor("openai", "gpt-5.6")).toMatchObject({
		modelId: "gpt-5.6",
		limits: { contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 },
		pricing: {
			inputPerMillionTokensUsd: 4,
			outputPerMillionTokensUsd: 20,
			cacheReadPerMillionTokensUsd: 0.4,
			cacheWritePerMillionTokensUsd: 5,
			tiers: [
				{
					inputTokensAbove: 200_000,
					inputPerMillionTokensUsd: 8,
					outputPerMillionTokensUsd: 30,
					cacheReadPerMillionTokensUsd: 0.8,
					cacheWritePerMillionTokensUsd: 10,
				},
				{
					inputTokensAbove: 272_000,
					inputPerMillionTokensUsd: 8,
					outputPerMillionTokensUsd: 30,
					cacheReadPerMillionTokensUsd: 0.8,
					cacheWritePerMillionTokensUsd: 10,
				},
			],
		},
		reasoningEfforts: ["off", "low", "medium", "high", "xhigh", "max"],
		promptCacheRetentionTiers: ["short"],
	});
	expect(modelFor("openai", "gpt-6-terra")).toMatchObject({
		modelId: "gpt-6-terra",
		promptCacheRetentionTiers: ["short"],
	});
	expect(modelFor("openai", "gpt-6-terra")).not.toHaveProperty(
		"reasoningEfforts"
	);

	expect(modelFor("anthropic", "claude-opus-4-5")).toMatchObject({
		limits: { contextWindowTokens: 200_000, maxOutputTokens: 64_000 },
		pricing: {
			inputPerMillionTokensUsd: 5,
			outputPerMillionTokensUsd: 25,
			cacheReadPerMillionTokensUsd: 0.5,
			cacheWritePerMillionTokensUsd: 6.25,
		},
		reasoningEfforts: ["off", "low", "medium", "high"],
		promptCacheRetentionTiers: ["short", "long"],
	});
	expect(modelFor("anthropic", "claude-opus-5.5")).toMatchObject({
		promptCacheRetentionTiers: ["short", "long"],
	});
	expect(modelFor("anthropic", "claude-opus-5.5")).not.toHaveProperty(
		"reasoningEfforts"
	);
	expect(modelFor("anthropic", "claude-haiku-4-5")).toMatchObject({
		reasoningEfforts: ["off", "low", "medium", "high"],
	});

	expect(modelFor("google", "gemini-3.6-flash").reasoningEfforts).toEqual([
		"minimal",
		"low",
		"medium",
		"high",
	]);
	expect(modelFor("google", "gemini-3.6-flash")).not.toHaveProperty(
		"promptCacheRetentionTiers"
	);
	expect(modelFor("google", "gemini-3.8-flash")).toMatchObject({
		limits: { contextWindowTokens: 1_048_576, maxOutputTokens: 65_536 },
		pricing: {
			inputPerMillionTokensUsd: 0.75,
			outputPerMillionTokensUsd: 3.75,
			cacheReadPerMillionTokensUsd: 0.075,
		},
		reasoningEfforts: ["low", "medium", "high"],
		promptCacheRetentionTiers: ["short", "long"],
	});

	// Per-model maps can remove defaults or enable extended levels.
	const expectedReasoningEfforts = [
		["anthropic", "claude-opus-4-5-20251101", ["off", "low", "medium", "high"]],
		[
			"anthropic",
			"claude-opus-4-7",
			["off", "low", "medium", "high", "xhigh", "max"],
		],
		[
			"anthropic",
			"claude-sonnet-5",
			["off", "low", "medium", "high", "xhigh", "max"],
		],
		[
			"anthropic",
			"claude-opus-4-8",
			["off", "low", "medium", "high", "xhigh", "max"],
		],
		["anthropic", "claude-fable-5", ["low", "medium", "high", "xhigh", "max"]],
		[
			"anthropic",
			"claude-fable-5-1",
			["low", "medium", "high", "xhigh", "max"],
		],
		["anthropic", "claude-opus-5", ["low", "medium", "high", "xhigh", "max"]],
		["anthropic", "claude-opus-4-6", ["off", "low", "medium", "high", "max"]],
		["anthropic", "claude-sonnet-4-6", ["off", "low", "medium", "high", "max"]],
		[
			"anthropic",
			"claude-haiku-4-5-20251001",
			["off", "low", "medium", "high"],
		],
		["anthropic", "claude-sonnet-4-5", ["off", "low", "medium", "high"]],
		[
			"anthropic",
			"claude-sonnet-4-5-20250929",
			["off", "low", "medium", "high"],
		],
		["google", "gemini-3.6-flash", ["minimal", "low", "medium", "high"]],
		["google", "gemini-3.7-flash", ["low", "medium", "high"]],
		["google", "gemini-3.8-flash", ["low", "medium", "high"]],
		["openai", "gpt-6.1-sol", ["low", "medium", "high", "xhigh", "max"]],
		["openai", "gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
		["opencode-go", "grok-4.6", ["low", "medium", "high", "xhigh"]],
		["opencode-go", "gpt-5.6-luna", ["low", "medium", "high", "xhigh", "max"]],
		["opencode-go", "glm-5.3-flash", ["low", "high", "max"]],
		["opencode-go", "glm-5.3", ["low", "high", "max"]],
		["opencode-go", "glm-5.2", ["high", "max"]],
		["opencode-go", "kimi-k3", ["max"]],
		[
			"opencode-go",
			"muse-spark-1.3-contributor",
			["minimal", "low", "medium", "high", "xhigh"],
		],
		[
			"opencode-go",
			"muse-spark-1.2-contributor",
			["minimal", "low", "medium", "high", "xhigh"],
		],
		["opencode-go", "deepseek-v4.1-flash", ["low", "high", "max"]],
		["opencode-go", "qwen3.8-max", ["off", "low", "medium", "xhigh"]],
		["opencode-go", "qwen3.8-flash", ["off", "low", "medium", "xhigh"]],
		[
			"opencode-go",
			"kimi-k2.7-code",
			["off", "minimal", "low", "medium", "high"],
		],
		["opencode-go", "minimax-m2.7", ["off", "low", "medium", "high"]],
		["opencode-go", "mimo-v2.5", ["off", "minimal", "low", "medium", "high"]],
		[
			"opencode-go",
			"mimo-v2.5-pro",
			["off", "minimal", "low", "medium", "high"],
		],
		["opencode-go", "minimax-m3", ["off", "low", "medium", "high"]],
		["opencode-go", "qwen3.7-plus", ["off", "low", "medium", "high"]],
		["opencode-go", "deepseek-v4-flash", ["off", "low", "high", "max"]],
		[
			"opencode-go",
			"deepseek-v4-flash-vision-exp",
			["off", "low", "high", "max"],
		],
	] as const;
	for (const [providerId, modelId, efforts] of expectedReasoningEfforts) {
		expect(modelFor(providerId, modelId).reasoningEfforts).toEqual(efforts);
	}
	// A reasoning declaration without a model-specific map uses shared defaults.
	expect(modelFor("opencode-go", "longcat-2.0").reasoningEfforts).toEqual([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
	]);

	expect(modelFor("opencode-go", "gpt-5.6-luna")).toMatchObject({
		limits: { contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 },
		pricing: {
			inputPerMillionTokensUsd: 0.2,
			outputPerMillionTokensUsd: 1.2,
			cacheReadPerMillionTokensUsd: 0.02,
			cacheWritePerMillionTokensUsd: 0.25,
			tiers: [
				{
					inputTokensAbove: 200_000,
					inputPerMillionTokensUsd: 0.4,
					outputPerMillionTokensUsd: 1.8,
					cacheReadPerMillionTokensUsd: 0.04,
					cacheWritePerMillionTokensUsd: 0.5,
				},
				{
					inputTokensAbove: 272_000,
					inputPerMillionTokensUsd: 0.4,
					outputPerMillionTokensUsd: 1.8,
					cacheReadPerMillionTokensUsd: 0.04,
					cacheWritePerMillionTokensUsd: 0.5,
				},
			],
		},
	});
	expect(modelFor("opencode-go", "grok-4.6")).toMatchObject({
		limits: { contextWindowTokens: 500_000, maxOutputTokens: 500_000 },
		modelId: "grok-4.6",
		pricing: {
			cacheReadPerMillionTokensUsd: 0.5,
			inputPerMillionTokensUsd: 2,
			outputPerMillionTokensUsd: 6,
			tiers: [
				{
					cacheReadPerMillionTokensUsd: 1,
					inputPerMillionTokensUsd: 4,
					inputTokensAbove: 200_000,
					outputPerMillionTokensUsd: 12,
				},
			],
		},
		protocolId: "openai-responses",
		providerId: "opencode-go",
		reasoningEfforts: ["low", "medium", "high", "xhigh"],
	});
	expect(modelFor("opencode-go", "longcat-2.0")).toMatchObject({
		reasoningEfforts: ["off", "minimal", "low", "medium", "high"],
	});
	expect(modelFor("opencode-go", "glm-5.1")).toEqual({
		modelId: "glm-5.1",
		protocolId: "openai-compatible",
		providerId: "opencode-go",
	});
	expect(modelFor("deepseek", "deepseek-reasoner")).not.toHaveProperty(
		"reasoningEfforts"
	);
	expect(modelFor("deepseek", "deepseek-reasoner")).not.toHaveProperty(
		"promptCacheRetentionTiers"
	);
	expect(modelFor("deepseek", "deepseek-reasoner")).not.toHaveProperty(
		"limits"
	);
	expect(modelFor("deepseek", "deepseek-reasoner")).not.toHaveProperty(
		"pricing"
	);
});

test("Provider Model enrichment preserves exact limits and every published price tier", () => {
	const model: ProviderModel = {
		modelId: "priced-model",
		protocolId: "openai-responses",
		providerId: "openai",
	};

	expect(
		withProviderModelMetadata(model, {
			cost: { cacheRead: 0.4, cacheWrite: 5, input: 4, output: 20 },
			limits: { context: 1_050_000, output: 128_000 },
			tiers: [
				{
					inputTokensAbove: 200_000,
					cacheRead: 0.8,
					cacheWrite: 10,
					input: 8,
					output: 30,
				},
			],
		})
	).toEqual({
		...model,
		limits: { contextWindowTokens: 1_050_000, maxOutputTokens: 128_000 },
		pricing: {
			cacheReadPerMillionTokensUsd: 0.4,
			cacheWritePerMillionTokensUsd: 5,
			inputPerMillionTokensUsd: 4,
			outputPerMillionTokensUsd: 20,
			tiers: [
				{
					inputTokensAbove: 200_000,
					cacheReadPerMillionTokensUsd: 0.8,
					cacheWritePerMillionTokensUsd: 10,
					inputPerMillionTokensUsd: 8,
					outputPerMillionTokensUsd: 30,
				},
			],
		},
	});
	// An absent source fact cannot be made up from a Catalog or adjacent model.
	expect(withProviderModelMetadata(model, {})).toEqual(model);
});

test("Provider Model cache TTL uses only explicit protocol retention values", () => {
	const model: ProviderModel = {
		modelId: "cache-model",
		protocolId: "openai-responses",
		providerId: "openai",
	};
	const promptCache = {
		explicit: { retentionTiers: ["short", "long"] },
		protocols: {
			"openai-responses": {
				eligibility: { minimumInputTokens: 1024 },
				retention: {
					field: "prompt_cache_options.ttl",
					values: { short: "30m", long: "1h" },
				},
			},
		},
	} as const;

	expect(withProviderModelMetadata(model, { promptCache })).toMatchObject({
		promptCacheRetentionTiers: ["short", "long"],
		promptCacheRetentionTtlMs: { long: 3_600_000, short: 1_800_000 },
	});
	expect(parsePromptCacheTtlMs("300s")).toBe(300_000);
	expect(parsePromptCacheTtlMs("30m")).toBe(1_800_000);
	expect(parsePromptCacheTtlMs("1h")).toBe(3_600_000);
	expect(parsePromptCacheTtlMs("1d")).toBeUndefined();
	expect(parsePromptCacheTtlMs("0s")).toBeUndefined();
});

test("Provider Model reasoning exposes shared defaults unless metadata restricts them", () => {
	const model = providerFor([
		{
			modelId: "policy-model",
			protocolId: "fixture",
			providerId: "fixture",
		},
	]).models[0];
	if (!model) {
		throw new Error("Missing fixture Provider Model");
	}

	expect(
		withProviderModelMetadata(model, {
			thinking: {
				levels: ["low", "high"],
				levelMap: { low: null, max: "maximum", off: "disabled" },
			},
			promptCache: { explicit: { retentionTiers: ["short", "long"] } },
		})
	).toMatchObject({
		reasoningEfforts: ["off", "high", "max"],
		promptCacheRetentionTiers: ["short", "long"],
	});

	expect(
		withProviderModelMetadata(model, { thinking: { toggle: true } })
	).toEqual({
		...model,
		reasoningEfforts: ["off", "minimal", "low", "medium", "high"],
	});
	expect(
		withProviderModelMetadata(model, {
			thinking: { levels: ["low"] },
		})
	).toMatchObject({ reasoningEfforts: ["off", "low"] });
	expect(
		withProviderModelMetadata(model, {
			thinking: { levels: ["low"], levelMap: { off: null } },
		})
	).toMatchObject({ reasoningEfforts: ["low"] });
	expect(
		withProviderModelMetadata(model, {
			thinking: { toggle: true, unlevelled: true },
		})
	).toMatchObject({
		reasoningEfforts: ["off", "minimal", "low", "medium", "high"],
	});
});
