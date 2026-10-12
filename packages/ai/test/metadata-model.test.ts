import { describe, expect, test } from "bun:test";
import { buildModelMetadataFile } from "../scripts/metadata-model";
import { anthropicModelMetadataById } from "../src/generated/anthropic-model-metadata.generated";
import { googleModelMetadataById } from "../src/generated/google-model-metadata.generated";
import { googleSdkModels } from "../src/generated/google-sdk-models.generated";
import { modelMetadataByKey } from "../src/generated/model-metadata.generated";
import { openCodeGoSdkModels } from "../src/generated/opencode-go-sdk-models.generated";
import { modelMetadataEntrySchema } from "../src/model-metadata";

/**
 * The generator is what guarantees every selectable model has metadata to
 * offer, so these cases assert the two ways that guarantee breaks: an entry
 * missing from the output, and a coverage report that miscounts what it
 * covered — the latter already shipped once and made the printed summary
 * overstate its own reach (#57).
 */

const catalog = [
	{
		connectionProviderId: "openai",
		id: "from-source",
		lifecycle: "active" as const,
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		id: "from-overlay",
		lifecycle: "active" as const,
		provider: "openai",
	},
	{
		connectionProviderId: "google",
		id: "absent",
		lifecycle: "active" as const,
		provider: "google",
	},
	{
		connectionProviderId: "openai",
		id: "empty-source",
		lifecycle: "active" as const,
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		id: "gone",
		lifecycle: "retired" as const,
		provider: "openai",
	},
	{
		connectionProviderId: "openai",
		id: "retired-source",
		lifecycle: "retired" as const,
		provider: "openai",
	},
];

const payload = {
	openai: {
		models: {
			"from-source": {
				cost: { input: 1, output: 2 },
				limit: { context: 1000 },
			},
			"empty-source": {},
			"retired-source": {
				reasoning_options: [{ type: "effort", values: ["low"] }],
			},
		},
	},
};

const build = (overlays = {}) =>
	buildModelMetadataFile({
		catalog,
		generatedAt: "2026-01-01",
		overlays,
		payload,
		source: "https://example.test/api.json",
	});

describe("buildModelMetadataFile", () => {
	test("returns an entry for every catalog model, including retired ones", () => {
		const { entries } = build();
		expect(Object.keys(entries).sort()).toEqual(
			catalog.map((entry) => `${entry.connectionProviderId}/${entry.id}`).sort()
		);
	});

	test("keeps a retired entry empty rather than dropping it", () => {
		expect(build().entries["openai/gone"]).toEqual({});
	});
	test("preserves available metadata for retired entries", () => {
		expect(build().entries["openai/retired-source"]).toEqual({
			thinking: { levels: ["low"] },
		});
	});
	test("counts active entries rather than counting each source separately", () => {
		const { coverage } = build({
			"openai/from-overlay": { cost: { input: 9, output: 9 } },
		});
		// One entry is served by both the source and an overlay; counting the
		// overlay as its own entry reported more models than the catalog holds.
		expect(coverage.activeEntries).toBe(4);
		expect(coverage.fromSource).toBe(1);
		expect(coverage.fromOverlay).toEqual(["openai/from-overlay"]);
		expect(coverage.retiredEntries).toBe(2);
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
		expect(result.contents).toContain(
			"// Upstream-missing entries (including overlay-covered): openai/from-overlay, google/absent, openai/empty-source."
		);
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

	test("generates Anthropic-only model metadata for the isolated provider runtime", () => {
		const promptCache = {
			explicit: { retentionTiers: ["short", "long"] },
		} as const;
		const result = buildModelMetadataFile({
			catalog: [
				{
					connectionProviderId: "anthropic",
					id: "claude-custom",
					lifecycle: "active",
					provider: "anthropic",
				},
			],
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

	test("emits provider-only active models and Google metadata from the canonical catalog", () => {
		const result = buildModelMetadataFile({
			catalog: [
				{
					connectionProviderId: "google",
					displayName: "Gemini current",
					id: "gemini-current",
					lifecycle: "active",
					provider: "google",
				},
				{
					connectionProviderId: "google",
					displayName: "Gemini retired",
					id: "gemini-retired",
					lifecycle: "retired",
					provider: "google",
				},
				{
					connectionProviderId: "opencode-go",
					displayName: "OpenAI route",
					id: "zen-openai",
					lifecycle: "active",
					protocol: "openai",
					provider: "opencode-go",
				},
				{
					connectionProviderId: "opencode-go",
					displayName: "Messages route",
					id: "zen-messages",
					lifecycle: "active",
					protocol: "anthropic",
					provider: "opencode-go",
				},
				{
					connectionProviderId: "opencode-go",
					displayName: "Compatible route",
					id: "zen-compatible",
					lifecycle: "active",
					protocol: "openai-compatible",
					provider: "opencode-go",
				},
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

		expect(result.googleSdkModels).toEqual([
			{
				modelId: "gemini-current",
				protocolId: "google",
				providerId: "google",
			},
		]);
		expect(result.openCodeGoSdkModels).toEqual([
			{
				modelId: "zen-openai",
				protocolId: "openai-responses",
				providerId: "opencode-go",
			},
			{
				modelId: "zen-messages",
				protocolId: "anthropic",
				providerId: "opencode-go",
			},
			{
				modelId: "zen-compatible",
				protocolId: "openai-compatible",
				providerId: "opencode-go",
			},
		]);
		expect(
			result.googleModelMetadataEntries["gemini-current"]?.promptCache
		).toEqual({
			explicit: { retentionTiers: ["short"] },
			googleCachedContent: { ttl: { short: "300s" } },
		});
		expect(result.googleModelMetadataContents).not.toContain("openai/");
	});

	test("generated Google SDK models and metadata remain provider-only", () => {
		expect(
			googleSdkModels.every((model) => model.providerId === "google")
		).toBe(true);
		expect(googleSdkModels).toHaveLength(3);
		expect(googleModelMetadataById["gemini-3.8-flash"]?.promptCache).toEqual(
			modelMetadataByKey["google/gemini-3.8-flash"]?.promptCache
		);
		expect(
			Object.fromEntries(
				Object.entries(modelMetadataByKey)
					.filter(([key]) => key.startsWith("google/"))
					.map(([key, metadata]) => [key.slice("google/".length), metadata])
			)
		).toEqual(googleModelMetadataById);
		expect(
			openCodeGoSdkModels.every((model) => model.providerId === "opencode-go")
		).toBe(true);
		expect(openCodeGoSdkModels).toHaveLength(27);
		expect(
			googleSdkModels.some((model) => model.modelId === "gemini-3.6-flash")
		).toBe(true);
	});

	test("committed Anthropic-only metadata matches the provider entries in the shared snapshot", () => {
		const sharedAnthropicMetadata = Object.fromEntries(
			Object.entries(modelMetadataByKey)
				.filter(([key]) => key.startsWith("anthropic/"))
				.map(([key, value]) => [key.slice("anthropic/".length), value])
		);
		expect(anthropicModelMetadataById).toEqual(sharedAnthropicMetadata);
	});

	test("returns entries accepted by the runtime metadata schema", () => {
		for (const entry of Object.values(build().entries)) {
			expect(modelMetadataEntrySchema.safeParse(entry).success).toBe(true);
		}
	});
});
