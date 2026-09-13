import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import type { SessionMessage } from "@/modules/sessions/message";
import { summarizeSessionUsage, turnCostUsd } from "./session-usage";

const model: ChatModelSelection = {
	modelId: "claude-haiku-4-5",
	providerId: "anthropic",
};

const assistant = (
	id: string,
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	}
): SessionMessage => ({
	id,
	metadata: usage ? { model, usage } : { model },
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});

/**
 * Pricing arithmetic has its own contract and is asserted directly: going
 * through `summarizeSessionUsage` would entangle it with catalog lookup and
 * live-table merging, which have separate cases below.
 */
describe("turnCostUsd", () => {
	const rates = { cacheRead: 1, cacheWrite: 2, input: 4, output: 20 };

	test("charges cache reads and writes at their own rates", () => {
		// 400k uncached * $4 + 1M out * $20 + 500k read * $1 + 100k write * $2.
		expect(
			turnCostUsd(
				{ cost: rates },
				{
					cacheReadTokens: 500_000,
					cacheWriteTokens: 100_000,
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
				}
			)
		).toBeCloseTo(1.6 + 20 + 0.5 + 0.2, 9);
	});

	test("does not charge cache reads at the uncached input rate", () => {
		// Without a published cache rate the safe answer is to charge nothing
		// for cached tokens rather than to reuse the input rate and overstate
		// the bill. The catalog never publishes a cache rate for OpenAI, so
		// this is the common path, not an edge case.
		expect(
			turnCostUsd(
				{ cost: { input: 4, output: 20 } },
				{
					cacheReadTokens: 1_000_000,
					inputTokens: 1_000_000,
					outputTokens: 0,
				}
			)
		).toBe(0);
	});

	test("applies the highest tier the turn's total input crossed", () => {
		const entry = {
			cost: rates,
			tiers: [
				{ inputTokensAbove: 200, input: 5, output: 15 },
				{ inputTokensAbove: 500, input: 9, output: 25 },
			],
		};
		// 300 total input crosses the 200 tier but not the 500 one.
		expect(
			turnCostUsd(entry, { inputTokens: 300, outputTokens: 1000 })
		).toBeCloseTo((300 / 1_000_000) * 5 + (1000 / 1_000_000) * 15, 9);
		// 600 total input crosses both, so the highest applies.
		expect(
			turnCostUsd(entry, { inputTokens: 600, outputTokens: 0 })
		).toBeCloseTo((600 / 1_000_000) * 9, 9);
	});

	test("counts cached input toward the tier threshold", () => {
		// The threshold is about how much context the request carried, so a
		// cache-heavy request must still cross it — but a tier only overrides
		// the rates it actually declares, so the cache read rate here stays at
		// the flat one.
		const entry = {
			cost: rates,
			tiers: [{ inputTokensAbove: 200, input: 5, output: 15 }],
		};
		expect(
			turnCostUsd(entry, {
				cacheReadTokens: 300,
				inputTokens: 300,
				outputTokens: 0,
			})
		).toBeCloseTo((300 / 1_000_000) * rates.cacheRead, 9);
		expect(
			turnCostUsd(entry, {
				cacheReadTokens: 300,
				inputTokens: 300,
				outputTokens: 1000,
			})
		).toBeCloseTo(
			(300 / 1_000_000) * rates.cacheRead + (1000 / 1_000_000) * 15,
			9
		);
	});

	test("lets a tier override the cache rate it declares", () => {
		expect(
			turnCostUsd(
				{
					cost: rates,
					tiers: [
						{ cacheRead: 9, input: 5, inputTokensAbove: 200, output: 15 },
					],
				},
				{ cacheReadTokens: 300, inputTokens: 300, outputTokens: 0 }
			)
		).toBeCloseTo((300 / 1_000_000) * 9, 9);
	});

	test("returns null when the model published no rates", () => {
		expect(turnCostUsd({}, { inputTokens: 10, outputTokens: 10 })).toBeNull();
		expect(
			turnCostUsd(undefined, { inputTokens: 10, outputTokens: 10 })
		).toBeNull();
	});
});

describe("summarizeSessionUsage", () => {
	test("retains the last provider usage until the next completed assistant", () => {
		const measured = assistant("assistant-1", {
			inputTokens: 90,
			outputTokens: 10,
		});
		const beforeNextUsage = summarizeSessionUsage(
			[measured, { id: "user-2", parts: [], role: "user" }],
			model,
			{}
		);

		// The catalog supplies the limit even with no live table at all, so the
		// usage bar no longer depends on a successful fetch.
		expect(beforeNextUsage?.contextLimit).toBe(200_000);
		expect(beforeNextUsage?.contextTokens).toBe(100);

		const afterNextUsage = summarizeSessionUsage(
			[
				measured,
				{ id: "user-2", parts: [], role: "user" },
				assistant("assistant-2", { inputTokens: 40, outputTokens: 5 }),
			],
			model,
			{}
		);

		expect(afterNextUsage?.contextTokens).toBe(45);
	});

	test("hides the usage bar before any provider usage exists", () => {
		expect(
			summarizeSessionUsage(
				[{ id: "user-1", parts: [], role: "user" }],
				model,
				{}
			)
		).toBeNull();
	});

	test("accumulates a session total across measured turns", () => {
		const summary = summarizeSessionUsage(
			[
				assistant("assistant-1", {
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
				}),
				assistant("assistant-2", { inputTokens: 1_000_000, outputTokens: 0 }),
			],
			model,
			{
				"anthropic/claude-haiku-4-5": {
					cost: { input: 1, output: 5 },
					limits: { context: 1000 },
				},
			}
		);

		// Turn 1: 1M in * $1 + 1M out * $5. Turn 2: 1M in * $1.
		expect(summary?.costUsd).toBeCloseTo(7, 9);
		expect(summary?.costedTurns).toBe(2);
	});

	test("reports an unknown context limit instead of guessing one", () => {
		const noSnapshot = summarizeSessionUsage(
			[
				{
					id: "a1",
					metadata: {
						model: { modelId: "gemini-3-pro-preview", providerId: "google" },
						usage: { inputTokens: 1, outputTokens: 1 },
					},
					parts: [],
					role: "assistant",
				},
			],
			{ modelId: "gemini-3-pro-preview", providerId: "google" },
			{}
		);
		// No snapshot data for that entry at all, so the denominator is unknown
		// and the bar must not invent one.
		expect(noSnapshot?.contextLimit).toBeNull();
		expect(noSnapshot?.contextPercent).toBeNull();
	});
});
