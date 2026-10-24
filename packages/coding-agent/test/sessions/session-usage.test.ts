import { describe, expect, test } from "bun:test";
import { createProviderCollection, type ProviderModel } from "@wincode/ai";
import type { ProviderModelSelection } from "@/modules/providers/provider-model-selection";
import { resolveCompactionSettings } from "@/modules/sessions/compaction/config";
import type { SessionMessage } from "@/modules/sessions/message";
import type { SessionUsageEntry } from "@/modules/sessions/storage/session-store";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "@/modules/sessions/usage/context-window";
import {
	summarizeSessionUsage,
	turnCostUsd,
} from "@/modules/sessions/usage/session-usage";
import type { ConfigSnapshot } from "@/shared/config/config-store";
import {
	modelId,
	modelIdentity,
	sessionId,
	sessionMessageId,
	sessionUsageEntryId,
} from "../support/identifiers";

const model: ProviderModelSelection = {
	modelId: modelId("claude-haiku-4-5"),
	providerId: "anthropic",
};
const contextSnapshot = (contextWindowTokens: number): ConfigSnapshot => ({
	diagnostics: [],
	document: { contextWindowTokens },
	sourceFor: () => undefined,
	sources: [],
});

const anthropicModel: ProviderModel = {
	limits: { contextWindowTokens: 200_000 },
	modelId: model.modelId,
	pricing: {
		cacheReadPerMillionTokensUsd: 0.25,
		cacheWritePerMillionTokensUsd: 2,
		inputPerMillionTokensUsd: 1,
		outputPerMillionTokensUsd: 5,
	},
	protocolId: "fixture",
	providerId: model.providerId,
};

const assistant = (
	id: string,
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	},
	selection: ProviderModelSelection = model
): SessionMessage => ({
	id: sessionMessageId(id),
	metadata: usage
		? {
				model: selection,
				usage,
				contextMeasurement: { epoch: "initial", stepId: "step-1", usage },
			}
		: { model: selection },
	parts: [{ text: id, type: "text" }],
	role: "assistant",
});

describe("turnCostUsd", () => {
	const rates = { cacheRead: 1, cacheWrite: 2, input: 4, output: 20 };

	test("charges cache reads and writes at their own rates", () => {
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
		expect(
			turnCostUsd(entry, { inputTokens: 300, outputTokens: 1000 })
		).toBeCloseTo((300 / 1_000_000) * 5 + (1000 / 1_000_000) * 15, 9);
		expect(
			turnCostUsd(entry, { inputTokens: 600, outputTokens: 0 })
		).toBeCloseTo((600 / 1_000_000) * 9, 9);
	});

	test("counts cached input toward the tier threshold", () => {
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
		expect(
			turnCostUsd(undefined, { inputTokens: 10, outputTokens: 10 })
		).toBeNull();
	});
});

describe("summarizeSessionUsage", () => {
	test("uses compacted context for occupancy while preserving transcript billing and warm totals", () => {
		const old = assistant("before", {
			inputTokens: 90_000,
			outputTokens: 100,
			cacheReadTokens: 20_000,
		});
		const handoff: SessionMessage = {
			id: sessionMessageId("compaction:usage-epoch"),
			role: "user",
			parts: [{ type: "text", text: "Short handoff" }],
		};
		const compacted = summarizeSessionUsage(
			[old],
			model,
			[],
			"idle",
			[anthropicModel],
			[handoff, old]
		);
		expect(compacted).toMatchObject({
			contextSource: "estimated",
			cacheReadTokens: 20_000,
			costedTurns: 1,
		});
		expect(compacted?.contextTokens).toBeLessThan(100);
		const fresh: SessionMessage = {
			...assistant("after", { inputTokens: 100, outputTokens: 10 }),
			metadata: {
				model,
				usage: { inputTokens: 100, outputTokens: 10 },
				contextMeasurement: {
					epoch: handoff.id,
					stepId: "step-1",
					usage: { inputTokens: 100, outputTokens: 10 },
				},
			},
		};
		const measured = summarizeSessionUsage(
			[old, fresh],
			model,
			[],
			"idle",
			[anthropicModel],
			[handoff, fresh]
		);
		expect(measured).toMatchObject({
			contextTokens: 110,
			contextSource: "measured",
			costedTurns: 2,
			cacheReadTokens: 20_000,
		});
		expect(measured?.costUsd).toBeCloseTo(0.075_65, 9);
	});

	test("switching models uses the selected model's context metadata", () => {
		const selected: ProviderModelSelection = {
			providerId: "google",
			modelId: modelId("other-model"),
		};
		const result = summarizeSessionUsage(
			[assistant("old-model", { inputTokens: 90_000, outputTokens: 100 })],
			selected,
			[],
			"idle",
			[
				anthropicModel,
				{
					...selected,
					protocolId: "fixture",
					limits: { contextWindowTokens: 10_000 },
				},
			]
		);
		expect(result).toMatchObject({
			contextLimit: 10_000,
			contextSource: "estimated",
			costedTurns: 1,
		});
		expect(result?.contextTokens).toBeLessThan(100);
		expect(result?.costUsd).toBeCloseTo(0.0905, 9);
	});

	test("aggregate-only historical records are estimated rather than treated as request measurements", () => {
		const historic: SessionMessage = {
			id: sessionMessageId("legacy"),
			role: "assistant",
			parts: [{ type: "text", text: "Done" }],
			metadata: { model, usage: { inputTokens: 90_000, outputTokens: 100 } },
		};
		const result = summarizeSessionUsage([historic], model, [], "idle", [
			anthropicModel,
		]);
		expect(result).toMatchObject({
			contextSource: "estimated",
			costedTurns: 1,
		});
		expect(result?.contextTokens).toBeLessThan(100);
		expect(result?.costUsd).toBeCloseTo(0.0905, 9);
	});

	test("uses Provider metadata when no explicit global override is set", () => {
		const messages = [
			assistant("assistant-1", { inputTokens: 90, outputTokens: 10 }),
			{ id: sessionMessageId("user-2"), parts: [], role: "user" } as const,
			assistant("assistant-2", { inputTokens: 40, outputTokens: 5 }),
		];
		const summary = summarizeSessionUsage(messages, model, [], "idle", [
			anthropicModel,
		]);

		expect(summary).toMatchObject({
			contextLimit: 200_000,
			contextTokens: 45,
		});
	});

	test("uses the 272k fallback when Provider Model metadata is absent", () => {
		const summary = summarizeSessionUsage(
			[assistant("assistant-1", { inputTokens: 90, outputTokens: 10 })],
			model
		);

		expect(summary).toMatchObject({
			contextLimit: DEFAULT_CONTEXT_WINDOW_TOKENS,
			contextPercent: expect.any(Number),
		});
	});

	test("uses the explicit context-window override for the occupancy percentage", () => {
		const summary = summarizeSessionUsage(
			[assistant("assistant-1", { inputTokens: 9000, outputTokens: 100 })],
			model,
			[],
			"idle",
			[anthropicModel],
			undefined,
			contextSnapshot(10_000)
		);

		expect(summary).toMatchObject({ contextLimit: 10_000, contextPercent: 91 });
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
		const summary = summarizeSessionUsage(messages, model, [], "idle", [
			anthropicModel,
		]);

		expect(summary).toMatchObject({
			cacheReadTokens: 90,
			cacheWriteTokens: 30,
			contextTokens: 100,
		});
		expect(messages).toEqual(transcript);
	});

	test("adds durable warm usage once without changing Provider context", () => {
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
			[entry],
			"scheduled",
			[anthropicModel]
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

	test("hides the usage bar before any Provider usage exists", () => {
		expect(
			summarizeSessionUsage(
				[{ id: sessionMessageId("user-1"), parts: [], role: "user" }],
				model
			)
		).toBeNull();
	});

	test("accumulates exact Provider Model prices across measured turns", () => {
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
			[],
			"idle",
			[anthropicModel]
		);

		expect(summary?.costUsd).toBeCloseTo(6.725, 9);
		expect(summary?.costedTurns).toBe(2);
	});

	test("uses only the exact current Provider Model's published prices", () => {
		const selection: ProviderModelSelection = {
			modelId: modelId("vendor/current-model"),
			providerId: "openrouter",
		};
		const providerModel: ProviderModel = {
			limits: { contextWindowTokens: 80_000 },
			modelId: selection.modelId,
			pricing: {
				inputPerMillionTokensUsd: 2,
				outputPerMillionTokensUsd: 8,
			},
			protocolId: "openai-compatible",
			providerId: selection.providerId,
		};
		const summary = summarizeSessionUsage(
			[
				assistant(
					"provider-model-usage",
					{ inputTokens: 1_000_000, outputTokens: 1_000_000 },
					selection
				),
			],
			selection,
			[],
			"idle",
			[providerModel]
		);

		expect(summary).toMatchObject({
			contextLimit: 80_000,
			costUsd: 10,
			costedTurns: 1,
		});
	});

	test("prices cache categories and exact higher-tier rates", () => {
		const selection: ProviderModelSelection = {
			modelId: modelId("vendor/tiered-model"),
			providerId: "openrouter",
		};
		const providerModel: ProviderModel = {
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
		};
		const summary = summarizeSessionUsage(
			[
				assistant(
					"tiered-provider-model-usage",
					{
						cacheReadTokens: 200_000,
						cacheWriteTokens: 100_000,
						inputTokens: 1_000_000,
						outputTokens: 500_000,
					},
					selection
				),
			],
			selection,
			[],
			"idle",
			[providerModel]
		);

		expect(summary?.costUsd).toBeCloseTo(22.3, 9);
		expect(summary?.costedTurns).toBe(1);
	});

	test("reports partial totals when one exact Provider Model has unknown rates", () => {
		const pricedSelection: ProviderModelSelection = {
			modelId: modelId("vendor/priced-model"),
			providerId: "openrouter",
		};
		const unknownSelection: ProviderModelSelection = {
			modelId: modelId("vendor/unpriced-model"),
			providerId: "openrouter",
		};
		const providerModel: ProviderModel = {
			modelId: pricedSelection.modelId,
			pricing: { inputPerMillionTokensUsd: 2, outputPerMillionTokensUsd: 8 },
			protocolId: "openai-compatible",
			providerId: pricedSelection.providerId,
		};
		const summary = summarizeSessionUsage(
			[
				assistant(
					"priced-usage",
					{ inputTokens: 1_000_000, outputTokens: 0 },
					pricedSelection
				),
				assistant(
					"unpriced-usage",
					{ inputTokens: 10, outputTokens: 5 },
					unknownSelection
				),
			],
			pricedSelection,
			[],
			"idle",
			[providerModel]
		);

		expect(summary).toMatchObject({
			costUsd: 2,
			costCoverage: "partial",
			costedTurns: 1,
		});
	});

	test("invalid Provider context metadata falls back while valid metadata sets the limit", async () => {
		const providerId = "context-limit-fixture";
		const selection: ProviderModelSelection = {
			modelId: modelIdentity("context-limit-model"),
			providerId,
		};
		const message = assistant(
			"context-limit-usage",
			{ inputTokens: 5000, outputTokens: 0 },
			selection
		);
		const invalidLimits = [
			0,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		];
		for (const [index, contextWindowTokens] of invalidLimits.entries()) {
			const invalidSelection: ProviderModelSelection = {
				...selection,
				modelId: modelIdentity(`invalid-context-model-${index}`),
			};
			const collection = createProviderCollection();
			collection.register({
				id: providerId,
				models: [
					{
						limits: { contextWindowTokens },
						modelId: invalidSelection.modelId,
						protocolId: "fixture",
						providerId,
					},
				],
				resolveAuthorization: () => ({ authorization: "fixture-only" }),
				async *streamChat() {
					yield { type: "finish" };
				},
			});
			const providerModel = collection.getModel(
				providerId,
				invalidSelection.modelId
			);
			expect(providerModel?.limits?.contextWindowTokens).toBeUndefined();

			const invalidMessage = assistant(
				`context-limit-usage-${index}`,
				{ inputTokens: 5000, outputTokens: 0 },
				invalidSelection
			);
			const summary = summarizeSessionUsage(
				[invalidMessage],
				invalidSelection,
				[],
				"idle",
				collection.getModels()
			);
			expect(summary).toMatchObject({
				contextLimit: DEFAULT_CONTEXT_WINDOW_TOKENS,
			});
			expect(
				resolveCompactionSettings({ contextLimit: summary?.contextLimit })
			).toMatchObject({
				autoAvailable: true,
				modelContextLimit: DEFAULT_CONTEXT_WINDOW_TOKENS,
				thresholdTokens: 255_616,
			});
			await collection.close();
		}

		const collection = createProviderCollection();
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
		const validSummary = summarizeSessionUsage(
			[message],
			selection,
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

	test("uses the 272k fallback for an unknown Provider Model", () => {
		const unknownModel: ProviderModelSelection = {
			modelId: modelId("gemini-3-pro-preview"),
			providerId: "google",
		};
		const summary = summarizeSessionUsage(
			[assistant("a1", { inputTokens: 1, outputTokens: 1 }, unknownModel)],
			unknownModel
		);

		expect(summary?.contextLimit).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
		expect(summary?.contextPercent).not.toBeNull();
	});
});
