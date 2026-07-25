import { describe, expect, test } from "bun:test";
import {
	type ChatModelSelection,
	type CodingAgentUIMessage,
	defaultChatModelSelection,
} from "@wincode/ai";
import type { ModelPricingTable } from "@/modules/model-pricing";
import { summarizeSessionUsage } from "./session-usage";

const fallback: ChatModelSelection = defaultChatModelSelection;

const TABLE: ModelPricingTable = {
	"openai/gpt-5.4-mini": {
		contextLimit: 400_000,
		cost: { input: 0.25, output: 2 },
	},
	"openai/gpt-5-mini": {
		contextLimit: 400_000,
		cost: { input: 0.25, output: 2 },
	},
	"anthropic/claude-sonnet-4-6": {
		contextLimit: 1_000_000,
		cost: { input: 3, output: 15 },
	},
	"anthropic/claude-haiku-4-5": {
		contextLimit: 200_000,
		cost: { input: 1, output: 5 },
	},
	"google/gemma-4-31b-it": { contextLimit: 128_000 },
};

const makeAssistant = (
	id: string,
	usage: { inputTokens: number; outputTokens: number } | undefined,
	model: ChatModelSelection = { modelId: "gpt-5.4-mini", providerId: "openai" }
): CodingAgentUIMessage => ({
	id,
	metadata: usage ? { model, usage } : { model },
	parts: [{ text: "hi", type: "text" }],
	role: "assistant",
});

describe("summarizeSessionUsage", () => {
	test("returns null when no assistant message has usage", () => {
		expect(
			summarizeSessionUsage(
				[{ id: "u1", parts: [], role: "user" }, makeAssistant("a1", undefined)],
				fallback,
				TABLE
			)
		).toBeNull();
	});

	test("returns null for an empty message list", () => {
		expect(summarizeSessionUsage([], fallback, TABLE)).toBeNull();
	});

	test("uses the last assistant message's model for context limit", () => {
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 10_000, outputTokens: 500 },
					{
						modelId: "gpt-5.4-mini",
						providerId: "openai",
					}
				),
				makeAssistant(
					"a2",
					{ inputTokens: 20_000, outputTokens: 1000 },
					{
						modelId: "claude-sonnet-4-6",
						providerId: "anthropic",
					}
				),
			],
			fallback,
			TABLE
		);
		expect(summary?.contextLimit).toBe(1_000_000);
		expect(summary?.contextTokens).toBe(21_000);
		expect(summary?.contextPercent).toBe(2);
	});

	test("falls back to fallbackModel when the message model is unknown", () => {
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 64_000, outputTokens: 0 },
					{
						modelId: "no-such-model",
						providerId: "openai",
					}
				),
			],
			fallback,
			TABLE
		);
		// fallback is gpt-5.4-mini (wincode) which resolves to openai/gpt-5.4-mini.
		expect(summary?.contextLimit).toBe(400_000);
		expect(summary?.contextPercent).toBe(16);
	});

	test("accumulates cost across turns, one model per turn", () => {
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 1_000_000, outputTokens: 0 },
					{
						modelId: "gpt-5-mini",
						providerId: "openai",
					}
				),
				makeAssistant(
					"a2",
					{ inputTokens: 1_000_000, outputTokens: 0 },
					{
						modelId: "claude-haiku-4-5",
						providerId: "anthropic",
					}
				),
			],
			fallback,
			TABLE
		);
		expect(summary?.costUsd).toBeCloseTo(1.25, 6);
	});

	test("keeps the known cost when the last turn's model has no price", () => {
		// The session ends on an unpriced model (e.g. switched to an
		// OAuth-only one), but the $0.25 already spent on the first turn
		// must not disappear from the total.
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 1_000_000, outputTokens: 0 },
					{
						modelId: "gpt-5-mini",
						providerId: "openai",
					}
				),
				makeAssistant(
					"a2",
					{ inputTokens: 1_000_000, outputTokens: 0 },
					{
						modelId: "gemma-4-31b-it",
						providerId: "google",
					}
				),
			],
			fallback,
			TABLE
		);
		expect(summary?.costUsd).toBeCloseTo(0.25, 6);
	});

	test("returns null cost only when no turn has known pricing", () => {
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 1_000_000, outputTokens: 0 },
					{ modelId: "gemma-4-31b-it", providerId: "google" }
				),
			],
			fallback,
			TABLE
		);
		expect(summary?.costUsd).toBeNull();
	});

	test("total cost does not depend on turn order", () => {
		const priced = makeAssistant(
			"priced",
			{ inputTokens: 1_000_000, outputTokens: 0 },
			{ modelId: "gpt-5-mini", providerId: "openai" }
		);
		const unpriced = makeAssistant(
			"unpriced",
			{ inputTokens: 1_000_000, outputTokens: 0 },
			{ modelId: "gemma-4-31b-it", providerId: "google" }
		);
		const forward = summarizeSessionUsage([priced, unpriced], fallback, TABLE);
		const backward = summarizeSessionUsage([unpriced, priced], fallback, TABLE);
		expect(forward?.costUsd).toBeCloseTo(0.25, 6);
		expect(backward?.costUsd).toBeCloseTo(0.25, 6);
	});

	test("returns a null contextLimit and contextPercent when pricing can't be resolved for the last turn or the fallback", () => {
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 100, outputTokens: 10 },
					{ modelId: "gpt-5.1-codex", providerId: "openai" }
				),
			],
			{ modelId: "gpt-5.1-codex", providerId: "openai" },
			TABLE
		);
		expect(summary?.contextLimit).toBeNull();
		expect(summary?.contextPercent).toBeNull();
		expect(summary?.contextTokens).toBe(110);
	});

	test("clamps the percent at 100", () => {
		const summary = summarizeSessionUsage(
			[
				makeAssistant(
					"a1",
					{ inputTokens: 5_000_000, outputTokens: 0 },
					{
						modelId: "gpt-5.4-mini",
						providerId: "openai",
					}
				),
			],
			fallback,
			TABLE
		);
		expect(summary?.contextPercent).toBe(100);
	});

	test("ignores non-assistant messages even if they carried usage", () => {
		const summary = summarizeSessionUsage(
			[
				{
					id: "u1",
					metadata: {
						model: { modelId: "gpt-5.4-mini", providerId: "openai" },
						usage: { inputTokens: 1, outputTokens: 1 },
					},
					parts: [],
					role: "user",
				} as CodingAgentUIMessage,
			],
			fallback,
			TABLE
		);
		expect(summary).toBeNull();
	});
});
