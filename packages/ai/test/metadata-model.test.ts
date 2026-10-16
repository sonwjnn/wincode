import { describe, expect, test } from "bun:test";
import { buildModelMetadataFile } from "../scripts/metadata-model";
import { anthropicModelMetadataById } from "../src/generated/anthropic-model-metadata.generated";
import { googleModelMetadataById } from "../src/generated/google-model-metadata.generated";
import { openAIProviderModelMetadataById } from "../src/generated/openai-provider-model-metadata.generated";
import { modelMetadataEntrySchema } from "../src/model-metadata";
import { anthropicDefaultModelIds } from "../src/sdk-providers/anthropic-models";
import { googleProviderModels } from "../src/sdk-providers/google-models";
import { openAIDefaultModelIds } from "../src/sdk-providers/openai-models";
import { openCodeGoProviderModels } from "../src/sdk-providers/opencode-go-models";

/**
 * The generator is what guarantees every selectable model has metadata to
 * offer, so these cases assert the two ways that guarantee breaks: an entry
 * missing from the output, and a coverage report that miscounts what it
 * covered — the latter already shipped once and made the printed summary
 * overstate its own reach (#57).
 */

const providerModels = [
	{ modelId: "from-source", providerId: "openai" },
	{ modelId: "from-overlay", providerId: "openai" },
	{ modelId: "absent", providerId: "google" },
	{ modelId: "empty-source", providerId: "openai" },
];

const payload = {
	openai: {
		models: {
			"from-source": {
				cost: { input: 1, output: 2 },
				limit: { context: 1000 },
			},
			"empty-source": {},
		},
	},
};

const build = (overlays = {}) =>
	buildModelMetadataFile({
		providerModels,
		generatedAt: "2026-01-01",
		overlays,
		payload,
		source: "https://example.test/api.json",
	});

describe("buildModelMetadataFile", () => {
	test("returns one metadata entry for every Provider Model declared by an SDK Provider", () => {
		const { entries } = build();
		expect(Object.keys(entries).sort()).toEqual(
			providerModels
				.map((model) => `${model.providerId}/${model.modelId}`)
				.sort()
		);
	});

	test("coverage counts declared Provider Models once when source and overlay both apply", () => {
		const { coverage } = build({
			"openai/from-overlay": { cost: { input: 9, output: 9 } },
		});
		expect(coverage.providerModelCount).toBe(4);
		expect(coverage.fromSource).toBe(1);
		expect(coverage.fromOverlay).toEqual(["openai/from-overlay"]);
	});

	test("reports an entry with no source at all as absent and uncovered", () => {
		const { coverage } = build();
		// `from-overlay` and `empty-source` have no usable metadata, while
		// `absent` never appears upstream, so all three are real gaps.
		expect(coverage.absentUpstream).toEqual([
			"openai/from-overlay",
			"google/absent",
			"openai/empty-source",
		]);
		expect(coverage.uncovered).toEqual([
			"openai/from-overlay",
			"google/absent",
			"openai/empty-source",
		]);
	});

	test("does not name an overlayed gap as uncovered", () => {
		const result = build({
			"openai/from-overlay": { reasoningSummary: true },
		});
		// Both keys are still absent upstream, but only the unoverlayed one is
		// a gap the header should warn about.
		expect(result.coverage.absentUpstream).toEqual([
			"openai/from-overlay",
			"google/absent",
			"openai/empty-source",
		]);
		expect(result.coverage.uncovered).toEqual([
			"google/absent",
			"openai/empty-source",
		]);
		expect(result.coverage.fromOverlay).toEqual(["openai/from-overlay"]);
	});

	test("lets an overlay add and override metadata facts", () => {
		const { entries } = build({
			"openai/from-source": { reasoningSummary: true },
		});
		expect(entries["openai/from-source"]).toEqual({
			cost: { input: 1, output: 2 },
			limits: { context: 1000 },
			reasoningSummary: true,
		});

		const overridden = build({
			"openai/from-source": { cost: { input: 9, output: 9 } },
		}).entries["openai/from-source"];
		expect(overridden).toEqual({
			cost: { input: 9, output: 9 },
			limits: { context: 1000 },
		});
	});

	test("preserves explicit cache retention capabilities through metadata overlays", () => {
		const promptCache = {
			explicit: { retentionTiers: ["short", "long"] },
		} as const;
		const result = build({ "openai/from-overlay": { promptCache } });

		expect(result.entries["openai/from-overlay"]?.promptCache).toEqual(
			promptCache
		);
		expect(modelMetadataEntrySchema.safeParse({ promptCache }).success).toBe(
			true
		);
		expect(
			modelMetadataEntrySchema.safeParse({
				promptCache: { explicit: { retentionTiers: ["unsupported"] } },
			}).success
		).toBe(false);
	});

	test("preserves Google CachedContent TTL capabilities through metadata generation", () => {
		const promptCache = {
			explicit: { retentionTiers: ["short", "long"] },
			googleCachedContent: {
				ttl: { short: "300s", long: "3600s" },
			},
		} as const;
		const { entries } = build({ "google/absent": { promptCache } });

		expect(entries["google/absent"]?.promptCache).toEqual(promptCache);
		expect(modelMetadataEntrySchema.safeParse({ promptCache }).success).toBe(
			true
		);
		expect(
			modelMetadataEntrySchema.safeParse({
				promptCache: {
					explicit: { retentionTiers: ["short"] },
					googleCachedContent: { ttl: {} },
				},
			}).success
		).toBe(false);
	});

	test("preserves protocol-specific prompt-cache eligibility through metadata generation", () => {
		const promptCache = {
			explicit: { retentionTiers: ["short"] },
			protocols: {
				"openai-responses": {
					breakpoints: true,
					eligibility: { minimumInputTokens: 1024 },
					promptCacheKey: true,
					retention: {
						field: "prompt_cache_options.ttl",
						values: { short: "30m" },
					},
				},
			},
		} as const;
		const { entries } = build({ "openai/from-overlay": { promptCache } });
		expect(entries["openai/from-overlay"]?.promptCache).toEqual(promptCache);
		expect(modelMetadataEntrySchema.safeParse({ promptCache }).success).toBe(
			true
		);
		expect(
			modelMetadataEntrySchema.safeParse({
				promptCache: {
					...promptCache,
					protocols: {
						"openai-responses": {
							breakpoints: true,
							promptCacheKey: true,
							retention: {
								field: "prompt_cache_options.ttl",
								values: { short: "30m" },
							},
							eligibility: {},
							// Missing eligibility is deliberately invalid.
						},
					},
				},
			}).success
		).toBe(false);
	});

	test("generates OpenAI-only cache metadata for the isolated provider runtime", () => {
		const openAIResponseCache = {
			breakpoints: true,
			eligibility: { minimumInputTokens: 1024 },
			promptCacheKey: true,
			retention: {
				field: "prompt_cache_options.ttl",
				values: { short: "30m" },
			},
		} as const;
		const result = build({
			"openai/from-overlay": {
				promptCache: {
					explicit: { retentionTiers: ["short"] },
					protocols: { "openai-responses": openAIResponseCache },
				},
			},
			"google/absent": {
				promptCache: {
					explicit: { retentionTiers: ["short"] },
					googleCachedContent: { ttl: { short: "300s" } },
				},
			},
		});

		expect(result.openAIPromptCacheEntries).toEqual({
			"from-overlay": { "openai-responses": openAIResponseCache },
		});
		expect(result.openAIPromptCacheContents).not.toContain("google");
		expect(result.openAIPromptCacheContents).not.toContain(
			"googleCachedContent"
		);
	});

	test("generates exact OpenAI Provider Model limits, prices, reasoning, and cache choices", () => {
		const result = build({
			"openai/from-overlay": {
				cost: { input: 2, output: 4 },
				limits: { context: 1000 },
				promptCache: {
					explicit: { retentionTiers: ["short"] },
					protocols: {
						"openai-responses": {
							breakpoints: true,
							eligibility: { minimumInputTokens: 1024 },
							promptCacheKey: true,
							retention: {
								field: "prompt_cache_options.ttl",
								values: { short: "30m" },
							},
						},
					},
				},
				thinking: {
					levelMap: { max: null, off: "disabled", xhigh: "very_high" },
					levels: ["low", "high"],
					toggle: true,
				},
			},
		});

		expect(result.openAIProviderModelMetadataEntries).toEqual({
			"from-source": {
				limits: { contextWindowTokens: 1000 },
				pricing: {
					inputPerMillionTokensUsd: 1,
					outputPerMillionTokensUsd: 2,
				},
			},
			"from-overlay": {
				limits: { contextWindowTokens: 1000 },
				pricing: {
					inputPerMillionTokensUsd: 2,
					outputPerMillionTokensUsd: 4,
				},
				promptCacheRetentionTiers: ["short"],
				promptCacheRetentionTtlMs: { short: 1_800_000 },
				reasoningEfforts: ["none", "low", "high", "xhigh"],
			},
		});
		expect(result.openAIProviderModelMetadataContents).toContain(
			"inputPerMillionTokensUsd"
		);
		expect(result.openAIProviderModelMetadataContents).not.toContain("google/");
		expect(result.openAIProviderModelMetadataContents).not.toContain(
			"anthropic/"
		);
	});

	test("generates Anthropic-only model metadata for the isolated provider runtime", () => {
		const promptCache = {
			explicit: { retentionTiers: ["short", "long"] },
		} as const;
		const result = buildModelMetadataFile({
			providerModels: [{ modelId: "claude-custom", providerId: "anthropic" }],
			generatedAt: "2026-01-01",
			overlays: { "anthropic/claude-custom": { promptCache } },
			payload: {},
			source: "https://example.test/api.json",
		});

		expect(result.anthropicModelMetadataEntries).toEqual({
			"claude-custom": { promptCache },
		});
		expect(result.anthropicModelMetadataContents).toContain(
			'"claude-custom": {\n\t\t"promptCache"'
		);
		expect(result.anthropicModelMetadataContents).not.toContain("openai/");
		expect(result.anthropicModelMetadataContents).not.toContain("google/");
	});

	test("emits metadata for SDK-declared Provider Models without lifecycle filtering", () => {
		const result = buildModelMetadataFile({
			providerModels: [
				{ modelId: "gemini-current", providerId: "google" },
				{ modelId: "zen-openai", providerId: "opencode-go" },
				{ modelId: "zen-messages", providerId: "opencode-go" },
				{ modelId: "zen-compatible", providerId: "opencode-go" },
			],
			generatedAt: "2026-01-01",
			overlays: {
				"google/gemini-current": {
					promptCache: {
						explicit: { retentionTiers: ["short"] },
						googleCachedContent: { ttl: { short: "300s" } },
					},
				},
			},
			payload: {},
			source: "https://example.test/api.json",
		});

		expect(
			result.googleModelMetadataEntries["gemini-current"]?.promptCache
		).toEqual({
			explicit: { retentionTiers: ["short"] },
			googleCachedContent: { ttl: { short: "300s" } },
		});
		expect(result.googleModelMetadataContents).not.toContain("openai/");
	});

	test("generated OpenAI Provider Model metadata maps only exact published choices", () => {
		expect(openAIProviderModelMetadataById["gpt-5.6"]).toEqual({
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
					{
						inputTokensAbove: 272_000,
						cacheReadPerMillionTokensUsd: 0.8,
						cacheWritePerMillionTokensUsd: 10,
						inputPerMillionTokensUsd: 8,
						outputPerMillionTokensUsd: 30,
					},
				],
			},
			promptCacheRetentionTiers: ["short"],
			promptCacheRetentionTtlMs: { short: 1_800_000 },
			reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
		});
		expect(openAIProviderModelMetadataById["gpt-6-terra"]).toEqual({
			promptCacheRetentionTiers: ["short"],
			promptCacheRetentionTtlMs: { short: 1_800_000 },
		});
		expect(openAIProviderModelMetadataById["gpt-6-terra"]).not.toHaveProperty(
			"reasoningEfforts"
		);
		expect(Object.keys(openAIProviderModelMetadataById).toSorted()).toEqual(
			[...openAIDefaultModelIds].toSorted()
		);
	});

	test("provider SDK model sources stay provider-owned and metadata follows their declarations", () => {
		expect(
			googleProviderModels.every((model) => model.providerId === "google")
		).toBe(true);
		expect(googleProviderModels).toHaveLength(3);
		expect(googleModelMetadataById["gemini-3.8-flash"]?.promptCache).toEqual({
			explicit: { retentionTiers: ["short", "long"] },
			googleCachedContent: { ttl: { short: "300s", long: "3600s" } },
		});
		expect(Object.keys(googleModelMetadataById).toSorted()).toEqual(
			googleProviderModels.map(({ modelId }) => modelId).toSorted()
		);
		expect(
			openCodeGoProviderModels.every(
				(model) => model.providerId === "opencode-go"
			)
		).toBe(true);
		expect(openCodeGoProviderModels).toHaveLength(27);
		expect(Object.keys(anthropicModelMetadataById).toSorted()).toEqual(
			[...anthropicDefaultModelIds].toSorted()
		);
	});

	test("returns entries accepted by the runtime metadata schema", () => {
		for (const entry of Object.values(build().entries)) {
			expect(modelMetadataEntrySchema.safeParse(entry).success).toBe(true);
		}
	});
});
