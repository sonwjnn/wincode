import { describe, expect, test } from "bun:test";
import { buildModelMetadataFile } from "../scripts/metadata-model";
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

	test("returns entries accepted by the runtime metadata schema", () => {
		for (const entry of Object.values(build().entries)) {
			expect(modelMetadataEntrySchema.safeParse(entry).success).toBe(true);
		}
	});
});
