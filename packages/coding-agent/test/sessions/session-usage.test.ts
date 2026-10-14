import { describe, expect, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai/models";
import { createProviderCollection, type ProviderModel } from "@wincode/ai/sdk";
import { resolveCompactionSettings } from "@/modules/sessions/compaction/config";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";
import {
	summarizeSessionUsage,
	turnCostUsd,
} from "@/modules/sessions/usage/session-usage";
import {
	modelId,
	modelIdentity,
	sessionId,
	sessionMessageId,
	sessionUsageEntryId,
} from "../support/identifiers";

const model: ChatModelSelection = {
	modelId: modelId("claude-haiku-4-5"),
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
	id: sessionMessageId(id),
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

	test("reports unknown cache-read cost when its rate is unpublished", () => {
		expect(
			turnCostUsd(
				{ cost: { input: 4, output: 20 } },
				{
					cacheReadTokens: 1_000_000,
					inputTokens: 1_000_000,
					outputTokens: 0,
				}
			)
		).toBeNull();
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
			[measured, { id: sessionMessageId("user-2"), parts: [], role: "user" }],
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
				{ id: sessionMessageId("user-2"), parts: [], role: "user" },
				assistant("assistant-2", { inputTokens: 40, outputTokens: 5 }),
			],
			model,
			{}
		);

		expect(afterNextUsage?.contextTokens).toBe(45);
	});

	test("shows session cache totals without reducing the latest context measure", () => {
		const messages = [
			assistant("assistant-1", {
				inputTokens: 100,
				outputTokens: 5,
				cacheReadTokens: 30,
				cacheWriteTokens: 10,
			}),
			assistant("assistant-2", {
				inputTokens: 90,
				outputTokens: 10,
				cacheReadTokens: 60,
				cacheWriteTokens: 20,
			}),
		];
		const transcript = structuredClone(messages);

		const summary = summarizeSessionUsage(messages, model, {});

		expect(summary).toMatchObject({
			cacheReadTokens: 90,
			cacheWriteTokens: 30,
			contextTokens: 100,
		});
		expect(messages).toEqual(transcript);
	});

	test("adds durable warm usage to cost once without changing provider context", () => {
		const messages = [
			assistant("assistant-measured", {
				inputTokens: 100,
				outputTokens: 5,
				cacheReadTokens: 20,
			}),
		];
		const entry: SessionUsageEntry = {
			createdAt: new Date(100),
			id: sessionUsageEntryId("warm-entry-1"),
			kind: "cache-warm",
			model,
			sessionId: sessionId("warm-session"),
			usage: {
				cacheReadTokens: 700_000,
				inputTokens: 1_000_000,
				outputTokens: 1,
			},
		};
		const summary = summarizeSessionUsage(
			messages,
			model,
			{
				"anthropic/claude-haiku-4-5": {
					cost: { cacheRead: 0.25, input: 1, output: 5 },
					limits: { context: 1000 },
				},
			},
			[entry],
			"scheduled"
		);

		expect(summary).toMatchObject({
			cacheReadTokens: 700_020,
			cacheWarmingStatus: "scheduled",
			contextTokens: 105,
			costedTurns: 1,
			costedUsageEntries: 1,
		});
		expect(summary?.costUsd).toBeCloseTo(0.475_115, 9);
		expect(messages).toHaveLength(1);
	});

	test("hides the usage bar before any provider usage exists", () => {
		expect(
			summarizeSessionUsage(
				[{ id: sessionMessageId("user-1"), parts: [], role: "user" }],
				model,
				{}
			)
		).toBeNull();
	});

	test("accumulates a cache-aware session total across measured turns", () => {
		const summary = summarizeSessionUsage(
			[
				assistant("assistant-1", {
					cacheReadTokens: 500_000,
					cacheWriteTokens: 100_000,
					inputTokens: 1_000_000,
					outputTokens: 1_000_000,
				}),
				assistant("assistant-2", { inputTokens: 1_000_000, outputTokens: 0 }),
			],
			model,
			{
				"anthropic/claude-haiku-4-5": {
					cost: { cacheRead: 0.25, cacheWrite: 2, input: 1, output: 5 },
					limits: { context: 1000 },
				},
			}
		);

		// Turn 1: 400k uncached * $1 + 500k read * $0.25 + 100k write * $2 + 1M output * $5. Turn 2: 1M input * $1.
		expect(summary?.costUsd).toBeCloseTo(6.725, 9);
		expect(summary?.costedTurns).toBe(2);
	});

	test("prices Provider Models only from their exact published metadata", () => {
		const selection = {
			modelId: modelId("vendor/current-model"),
			providerId: "openrouter",
		};
		const messages: SessionMessage[] = [
			{
				id: sessionMessageId("provider-model-usage"),
				metadata: {
					model: selection,
					usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
				},
				parts: [],
				role: "assistant",
			},
		];
		const providerModels: readonly ProviderModel[] = [
			{
				limits: { contextWindowTokens: 80_000 },
				modelId: "vendor/current-model",
				pricing: {
					inputPerMillionTokensUsd: 2,
					outputPerMillionTokensUsd: 8,
				},
				protocolId: "openai-compatible",
				providerId: "openrouter",
			},
		];
		const summary = summarizeSessionUsage(
			messages,
			selection,
			{},
			[],
			"idle",
			providerModels
		);

		expect(summary).toMatchObject({
			contextLimit: 80_000,
			costUsd: 10,
			costedTurns: 1,
		});
	});

	test("prices Provider Model cache categories and exact higher-tier rates", () => {
		const selection = {
			modelId: modelId("vendor/tiered-model"),
			providerId: "openrouter",
		};
		const messages: SessionMessage[] = [
			{
				id: sessionMessageId("tiered-provider-model-usage"),
				metadata: {
					model: selection,
					usage: {
						cacheReadTokens: 200_000,
						cacheWriteTokens: 100_000,
						inputTokens: 1_000_000,
						outputTokens: 500_000,
					},
				},
				parts: [],
				role: "assistant",
			},
		];
		const providerModels: readonly ProviderModel[] = [
			{
				modelId: selection.modelId,
				pricing: {
					inputPerMillionTokensUsd: 4,
					outputPerMillionTokensUsd: 20,
					cacheReadPerMillionTokensUsd: 1,
					cacheWritePerMillionTokensUsd: 2,
					tiers: [
						{
							inputTokensAbove: 500_000,
							inputPerMillionTokensUsd: 9,
							outputPerMillionTokensUsd: 30,
							cacheReadPerMillionTokensUsd: 3,
							cacheWritePerMillionTokensUsd: 4,
						},
					],
				},
				protocolId: "openai-compatible",
				providerId: selection.providerId,
			},
		];
		const summary = summarizeSessionUsage(
			messages,
			selection,
			{},
			[],
			"idle",
			providerModels
		);

		expect(summary?.costUsd).toBeCloseTo(22.3, 9);
		expect(summary?.costedTurns).toBe(1);
	});

	test("does not substitute legacy catalog prices when a Provider Model is absent", () => {
		const selection = {
			modelId: modelId("gpt-5.6-luna"),
			providerId: "openai",
		};
		const summary = summarizeSessionUsage(
			[
				{
					id: sessionMessageId("unknown-provider-model"),
					metadata: {
						model: selection,
						usage: { inputTokens: 10, outputTokens: 5 },
					},
					parts: [],
					role: "assistant",
				},
			],
			selection,
			{
				"openai/gpt-5.6-luna": {
					cost: { input: 1, output: 2 },
					limits: { context: 100_000 },
				},
			},
			[],
			"idle",
			[]
		);

		expect(summary).toMatchObject({
			contextLimit: null,
			contextPercent: null,
			costUsd: null,
			costCoverage: "unknown",
			costedTurns: 0,
		});
	});

	test("qualifies session totals when one measured model has unknown rates", () => {
		const pricedSelection = {
			modelId: modelId("vendor/priced-model"),
			providerId: "openrouter",
		};
		const unknownSelection = {
			modelId: modelId("vendor/unpriced-model"),
			providerId: "openrouter",
		};
		const messages: SessionMessage[] = [
			{
				id: sessionMessageId("priced-usage"),
				metadata: {
					model: pricedSelection,
					usage: { inputTokens: 1_000_000, outputTokens: 0 },
				},
				parts: [],
				role: "assistant",
			},
			{
				id: sessionMessageId("unpriced-usage"),
				metadata: {
					model: unknownSelection,
					usage: { inputTokens: 10, outputTokens: 5 },
				},
				parts: [],
				role: "assistant",
			},
		];
		const providerModels: readonly ProviderModel[] = [
			{
				modelId: pricedSelection.modelId,
				pricing: { inputPerMillionTokensUsd: 2, outputPerMillionTokensUsd: 8 },
				protocolId: "openai-compatible",
				providerId: pricedSelection.providerId,
			},
		];
		const summary = summarizeSessionUsage(
			messages,
			pricedSelection,
			{},
			[],
			"idle",
			providerModels
		);

		expect(summary).toMatchObject({
			costUsd: 2,
			costCoverage: "partial",
			costedTurns: 1,
		});
	});

	test("rejects invalid Provider context limits before usage and compaction calculations", async () => {
		const providerId = "context-limit-fixture";
		const selection = {
			modelId: modelIdentity("context-limit-model"),
			providerId,
		};
		const message: SessionMessage = {
			id: sessionMessageId("context-limit-usage"),
			metadata: {
				model: selection,
				usage: { inputTokens: 5000, outputTokens: 0 },
			},
			parts: [],
			role: "assistant",
		};
		const collection = createProviderCollection();
		const invalidLimits = [
			0,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		for (const contextWindowTokens of invalidLimits) {
			expect(() =>
				collection.register({
					id: providerId,
					models: [
						{
							limits: { contextWindowTokens },
							modelId: selection.modelId,
							protocolId: "fixture",
							providerId,
						},
					],
					resolveAuthorization: () => ({ authorization: "fixture-only" }),
					async *streamChat() {
						yield { type: "finish" };
					},
				})
			).toThrow("Invalid model identity for provider context-limit-fixture.");

			const summary = summarizeSessionUsage(
				[message],
				selection,
				{},
				[],
				"idle",
				collection.getModels()
			);
			expect(summary).toMatchObject({
				contextLimit: null,
				contextPercent: null,
			});
			expect(
				resolveCompactionSettings({ contextLimit: summary?.contextLimit })
			).toMatchObject({
				autoAvailable: false,
				modelContextLimit: null,
				thresholdTokens: null,
			});
		}

		collection.register({
			id: providerId,
			models: [
				{
					limits: { contextWindowTokens: 10_000 },
					modelId: selection.modelId,
					protocolId: "fixture",
					providerId,
				},
			],
			resolveAuthorization: () => ({ authorization: "fixture-only" }),
			async *streamChat() {
				yield { type: "finish" };
			},
		});
		const validModels = collection.getModels();
		expect(collection.getModel(providerId, selection.modelId)).toMatchObject({
			limits: { contextWindowTokens: 10_000 },
		});
		const validSummary = summarizeSessionUsage(
			[message],
			selection,
			{},
			[],
			"idle",
			validModels
		);
		expect(validSummary).toMatchObject({
			contextLimit: 10_000,
			contextPercent: 50,
		});
		expect(
			resolveCompactionSettings({ contextLimit: validSummary?.contextLimit })
		).toMatchObject({
			autoAvailable: true,
			modelContextLimit: 10_000,
			thresholdTokens: 5000,
		});
		await collection.close();
	});

	test("reports an unknown context limit instead of guessing one", () => {
		const noSnapshot = summarizeSessionUsage(
			[
				{
					id: sessionMessageId("a1"),
					metadata: {
						model: {
							modelId: modelId("gemini-3-pro-preview"),
							providerId: "google",
						},
						usage: { inputTokens: 1, outputTokens: 1 },
					},
					parts: [],
					role: "assistant",
				},
			],
			{ modelId: modelId("gemini-3-pro-preview"), providerId: "google" },
			{}
		);
		// No snapshot data for that entry at all, so the denominator is unknown
		// and the bar must not invent one.
		expect(noSnapshot?.contextLimit).toBeNull();
		expect(noSnapshot?.contextPercent).toBeNull();
	});
});
