import { describe, expect, test } from "bun:test";
import { buildModelPricingTable } from "./models-dev-response";

const IDS = new Set([
	"gpt-5.4-mini",
	"claude-sonnet-4-6",
	"gemini-2.5-flash",
	"gemma-4-31b-it",
	"missing-context",
]);

describe("buildModelPricingTable", () => {
	test("extracts context limits and full cost for known ids", () => {
		const table = buildModelPricingTable(
			{
				openai: {
					models: {
						"gpt-5.4-mini": {
							cost: {
								cache_read: 0.075,
								input: 0.25,
								output: 2,
							},
							limit: { context: 400_000 },
						},
					},
				},
			},
			IDS
		);
		expect(table["openai/gpt-5.4-mini"]).toEqual({
			contextLimit: 400_000,
			cost: { cacheRead: 0.075, input: 0.25, output: 2 },
		});
	});

	test("skips entries without a context limit", () => {
		const table = buildModelPricingTable(
			{
				google: {
					models: {
						"gemini-2.5-flash": {
							cost: { input: 0.3, output: 2.5 },
						},
					},
				},
			},
			IDS
		);
		expect(table["google/gemini-2.5-flash"]).toBeUndefined();
	});

	test("skips entries whose id is not in the requested set", () => {
		const table = buildModelPricingTable(
			{
				openai: {
					models: {
						"unknown-model": {
							limit: { context: 1000 },
						},
					},
				},
			},
			IDS
		);
		expect(table).toEqual({});
	});

	test("keeps good entries and drops the malformed ones", () => {
		const table = buildModelPricingTable(
			{
				anthropic: {
					models: {
						"claude-sonnet-4-6": {
							cost: { input: 3, output: 15 },
							limit: { context: 1_000_000 },
						},
						"claude-broken": {
							cost: "not-a-number" as never,
							limit: { context: 1000 },
						},
					},
				},
				openai: {
					models: {
						"gpt-5.4-mini": {
							limit: { context: 400_000 },
						},
					},
				},
			},
			new Set(["claude-sonnet-4-6", "claude-broken", "gpt-5.4-mini"])
		);
		expect(table["anthropic/claude-sonnet-4-6"]).toEqual({
			contextLimit: 1_000_000,
			cost: { input: 3, output: 15 },
		});
		expect(table["anthropic/claude-broken"]).toBeUndefined();
		expect(table["openai/gpt-5.4-mini"]).toEqual({
			contextLimit: 400_000,
		});
	});

	test("returns an empty table for a totally invalid payload", () => {
		const table = buildModelPricingTable("not json", IDS);
		expect(table).toEqual({});
	});

	test("drops resellers that are not one of our runtime providers", () => {
		const table = buildModelPricingTable(
			{
				"302ai": {
					models: {
						"gpt-5.4-mini": {
							cost: { input: 0.1, output: 0.1 },
							limit: { context: 400_000 },
						},
					},
				},
				openai: {
					models: {
						"gpt-5.4-mini": {
							cost: { input: 0.25, output: 2 },
							limit: { context: 400_000 },
						},
					},
				},
			},
			IDS
		);
		expect(Object.keys(table)).toEqual(["openai/gpt-5.4-mini"]);
	});
});
