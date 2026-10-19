import { describe, expect, test } from "bun:test";
import { buildProviderModelsWithMetadata } from "../scripts/metadata-model";
import type { ModelMetadataEntry } from "../src/model-metadata";
import { modelMetadataEntrySchema } from "../src/model-metadata";
import type { ProviderModel } from "../src/sdk";

const providerModels: readonly ProviderModel[] = [
	{
		modelId: "from-source",
		protocolId: "openai-responses",
		providerId: "openai",
	},
	{
		modelId: "from-overlay",
		protocolId: "openai-responses",
		providerId: "openai",
	},
	{ modelId: "absent", protocolId: "google", providerId: "google" },
	{
		modelId: "empty-source",
		protocolId: "openai-responses",
		providerId: "openai",
	},
];

const payload = {
	openai: {
		models: {
			"from-source": {
				cost: { input: 1, output: 2 },
				limit: { context: 1000 },
				reasoning_options: [
					{
						type: "effort",
						values: ["low", "medium", "high", "xhigh", "max"],
					},
				],
			},
			"empty-source": {},
			unlisted: {
				cost: { input: 99, output: 99 },
				limit: { context: 99_000 },
			},
		},
	},
};

const build = (overlays: Readonly<Record<string, ModelMetadataEntry>> = {}) =>
	buildProviderModelsWithMetadata({
		overlays,
		payload,
		providerModels,
	});

const modelById = (models: readonly ProviderModel[], modelId: string) =>
	models.find((model) => model.modelId === modelId);

describe("Provider Model metadata enrichment", () => {
	test("only enriches identities declared by the provider manifest", () => {
		const result = build();
		expect(
			result.providerModels.map(
				({ providerId, modelId }) => `${providerId}/${modelId}`
			)
		).toEqual(
			providerModels.map(
				({ providerId, modelId }) => `${providerId}/${modelId}`
			)
		);
		expect(
			result.providerModels.some((model) => model.modelId === "unlisted")
		).toBe(false);
		expect(result.coverage.providerModelCount).toBe(4);
	});

	test("coverage counts each declared model once across source and overlay", () => {
		const result = build({
			"openai/from-overlay": { cost: { input: 9, output: 9 } },
		});
		expect(result.coverage.fromSource).toBe(1);
		expect(result.coverage.fromOverlay).toEqual(["openai/from-overlay"]);
		expect(result.coverage.absentUpstream).toEqual([
			"openai/from-overlay",
			"google/absent",
			"openai/empty-source",
		]);
		expect(result.coverage.uncovered).toEqual([
			"google/absent",
			"openai/empty-source",
		]);
	});

	test("published source facts become ProviderModel pricing and limits", () => {
		const model = modelById(build().providerModels, "from-source");
		expect(model?.pricing).toEqual({
			inputPerMillionTokensUsd: 1,
			outputPerMillionTokensUsd: 2,
		});
		expect(model?.limits).toEqual({ contextWindowTokens: 1000 });
	});

	test("manual reasoning overlays add a missing effort without hiding published levels", () => {
		const result = build({
			"openai/from-source": { thinking: { levels: ["minimal"] } },
		});
		expect(result.entries["openai/from-source"]?.thinking?.levels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
			"minimal",
		]);
		expect(
			modelById(result.providerModels, "from-source")?.reasoningEfforts
		).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
	});

	test("unknown source facts remain absent instead of receiving defaults", () => {
		const result = build();
		const model = modelById(result.providerModels, "absent");
		expect(model).toEqual(providerModels[2]);
		expect(result.entries["google/absent"]).toEqual({});
	});

	test("manual overlays override source values and survive on the generated model", () => {
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
		const result = build({
			"openai/from-source": {
				cost: { input: 9, output: 9 },
				promptCache,
			},
		});
		const model = modelById(result.providerModels, "from-source");
		expect(result.entries["openai/from-source"]).toMatchObject({
			cost: { input: 9, output: 9 },
			limits: { context: 1000 },
		});
		expect(model).toMatchObject({
			pricing: {
				inputPerMillionTokensUsd: 9,
				outputPerMillionTokensUsd: 9,
			},
			limits: { contextWindowTokens: 1000 },
			promptCache,
			promptCacheRetentionTiers: ["short"],
			promptCacheRetentionTtlMs: { short: 1_800_000 },
		});
	});

	test("Google CachedContent TTL is carried by its ProviderModel", () => {
		const promptCache = {
			explicit: { retentionTiers: ["short", "long"] },
			googleCachedContent: {
				ttl: { short: "300s", long: "3600s" },
			},
		} as const;
		const googleModel: ProviderModel = {
			modelId: "gemini-cache",
			protocolId: "google",
			providerId: "google",
		};
		const result = buildProviderModelsWithMetadata({
			overlays: { "google/gemini-cache": { promptCache } },
			payload: {},
			providerModels: [googleModel],
		});
		expect(result.providerModels[0]).toMatchObject({
			promptCache,
			promptCacheRetentionTiers: ["short", "long"],
		});
	});

	test("metadata overlay entries retain their runtime schema", () => {
		for (const entry of Object.values(build().entries)) {
			expect(modelMetadataEntrySchema.safeParse(entry).success).toBe(true);
		}
	});
});
