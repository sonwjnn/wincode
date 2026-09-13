import { describe, expect, test } from "bun:test";
import { convertModelsDevPayload } from "../src/models-dev";

/**
 * The converter is the one place a models.dev field is interpreted, and both
 * the offline metadata generator and the runtime pricing refresh call it. A
 * wrong reading here reaches every generated entry and every refreshed rate.
 */
describe("convertModelsDevPayload", () => {
	test("keeps a readable context limit when cost is unusable", () => {
		const converted = convertModelsDevPayload({
			openai: {
				models: {
					"broken-cost": {
						cost: "not-a-number",
						limit: { context: 400_000 },
					},
				},
			},
		});
		expect(converted.get("openai/broken-cost")).toEqual({
			limits: { context: 400_000 },
		});
	});

	test("drops upstream effort values outside the catalog's level set", () => {
		const converted = convertModelsDevPayload({
			openai: {
				models: {
					"weird-effort": {
						reasoning_options: [
							{ type: "effort", values: ["low", "ludicrous", "high"] },
						],
					},
				},
			},
		});
		expect(converted.get("openai/weird-effort")).toEqual({
			thinking: { levels: ["low", "high"] },
		});
	});

	test("keeps toggle and levels as independent axes", () => {
		const converted = convertModelsDevPayload({
			anthropic: {
				models: {
					"switchable-ladder": {
						reasoning_options: [
							{ type: "toggle" },
							{ type: "effort", values: ["low", "max"] },
							{ type: "budget_tokens", min: 1024 },
						],
					},
				},
			},
		});
		expect(converted.get("anthropic/switchable-ladder")).toEqual({
			thinking: { budgetMin: 1024, levels: ["low", "max"], toggle: true },
		});
	});

	test("represents a toggle-only model without inventing a level ladder", () => {
		const converted = convertModelsDevPayload({
			opencode_go: {
				models: {
					"switch-only": { reasoning_options: [{ type: "toggle" }] },
				},
			},
		});
		expect(converted.get("opencode_go/switch-only")).toEqual({
			thinking: { toggle: true },
		});
	});

	test("models an empty reasoning option list as no policy", () => {
		const converted = convertModelsDevPayload({
			google: { models: { silent: { reasoning_options: [] } } },
		});
		expect(converted.get("google/silent")).toEqual({});
	});

	test("folds context_over_200k into the tier list at its threshold", () => {
		const converted = convertModelsDevPayload({
			openai: {
				models: {
					tiered: {
						cost: {
							input: 1,
							output: 2,
							context_over_200k: { input: 3, output: 4 },
						},
					},
				},
			},
		});
		expect(converted.get("openai/tiered")).toEqual({
			cost: { input: 1, output: 2 },
			tiers: [{ inputTokensAbove: 200_000, input: 3, output: 4 }],
		});
	});

	test("orders tiers by ascending threshold", () => {
		const converted = convertModelsDevPayload({
			google: {
				models: {
					"two-tiers": {
						cost: {
							input: 1,
							output: 2,
							tiers: [
								{
									tier: { type: "context", size: 512_000 },
									input: 9,
									output: 9,
								},
								{
									tier: { type: "context", size: 200_000 },
									input: 4,
									output: 4,
								},
							],
						},
					},
				},
			},
		});
		expect(
			converted
				.get("google/two-tiers")
				?.tiers?.map((tier) => tier.inputTokensAbove)
		).toEqual([200_000, 512_000]);
	});

	test("drops a tier with no threshold instead of guessing one", () => {
		const converted = convertModelsDevPayload({
			google: {
				models: {
					"no-threshold": {
						cost: {
							input: 1,
							output: 2,
							tiers: [{ input: 5, output: 5 }],
						},
					},
				},
			},
		});
		expect(converted.get("google/no-threshold")).toEqual({
			cost: { input: 1, output: 2 },
		});
	});

	test("drops negative and non-integral remote numeric metadata", () => {
		const converted = convertModelsDevPayload({
			openai: {
				models: {
					"invalid-numbers": {
						cost: {
							input: -1,
							output: 2,
							tiers: [
								{
									input: -3,
									output: 4,
									tier: { size: 200_000.5 },
								},
							],
						},
						limit: { context: 400_000.5, output: -1 },
						reasoning_options: [
							{
								max: 8192.5,
								min: -1,
								type: "budget_tokens",
							},
						],
					},
				},
			},
		});
		expect(converted.get("openai/invalid-numbers")).toEqual({});
	});

	test("returns no entries for a payload that is not an object", () => {
		expect(convertModelsDevPayload("not json").size).toBe(0);
		expect(convertModelsDevPayload(null).size).toBe(0);
	});
});
