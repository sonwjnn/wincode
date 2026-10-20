import { describe, expect, test } from "bun:test";
import {
	modelFailureSchema,
	normalizeModelFailure,
} from "../src/model-failures";
import {
	calculateModelUsageCostUsd,
	formatModelTokenCount,
	getModelContextTokens,
	normalizeModelUsage,
} from "../src/model-usage";
import { thinkingLevelIds, thinkingLevelSchema } from "../src/sdk";

test("persisted Thinking Levels reject provider-native aliases", () => {
	expect(thinkingLevelIds).toEqual([
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	]);
	expect(thinkingLevelSchema.safeParse("min").success).toBe(false);
	expect(thinkingLevelSchema.safeParse("off").success).toBe(true);
	expect(thinkingLevelSchema.safeParse("thinking").success).toBe(false);
});

describe("provider-neutral model contracts", () => {
	test("normalizes usage and keeps model accounting provider-neutral", () => {
		const usage = normalizeModelUsage({
			inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 5 },
			inputTokens: 100,
			outputTokenDetails: { reasoningTokens: 10 },
			outputTokens: 25,
			totalTokens: 125,
		});
		expect(usage).toEqual({
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			inputTokens: 100,
			outputTokens: 25,
			reasoningTokens: 10,
			totalTokens: 125,
		});
		expect(usage && getModelContextTokens(usage)).toBe(125);
		expect(
			usage &&
				calculateModelUsageCostUsd(
					{ cacheRead: 0.1, cacheWrite: 0.2, input: 1, output: 2 },
					usage
				)
		).toBeCloseTo(0.000_128);
		expect(formatModelTokenCount(34_300)).toBe("34.3K");
		expect(
			normalizeModelUsage({
				cachedInputTokens: 4,
				inputTokens: 10,
				outputTokens: 2,
				reasoningTokens: 1,
			})
		).toEqual({
			cacheReadTokens: 4,
			inputTokens: 10,
			outputTokens: 2,
			reasoningTokens: 1,
		});
	});

	test("uses the highest crossed pricing tier when thresholds are unsorted", () => {
		const usage = normalizeModelUsage({ inputTokens: 600, outputTokens: 100 });
		if (!usage) {
			throw new Error("Expected normalized model usage.");
		}

		expect(
			calculateModelUsageCostUsd(
				{
					cost: { input: 1, output: 2 },
					tiers: [
						{ input: 20, inputTokensAbove: 500, output: 40 },
						{ input: 2, inputTokensAbove: 200, output: 4 },
					],
				},
				usage
			)
		).toBeCloseTo(0.016);
	});

	test("preserves normalized cache counts when normalizing Provider usage", () => {
		const usage = {
			cacheReadTokens: 20,
			cacheWriteTokens: 5,
			inputTokens: 100,
			outputTokens: 25,
			reasoningTokens: 10,
			totalTokens: 125,
		};

		expect(normalizeModelUsage(usage)).toEqual(usage);
	});

	test("keeps cached input cost unknown when a category rate is unpublished", () => {
		const usage = normalizeModelUsage({
			inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 5 },
			inputTokens: 100,
			outputTokens: 25,
		});
		if (!usage) {
			throw new Error("Expected normalized model usage.");
		}

		expect(
			calculateModelUsageCostUsd({ cacheRead: 0.1, input: 1, output: 2 }, usage)
		).toBeNull();
		expect(
			calculateModelUsageCostUsd(
				{ cacheWrite: 0.2, input: 1, output: 2 },
				usage
			)
		).toBeNull();
	});

	test("normalizes failures without exposing provider diagnostics", () => {
		const failure = normalizeModelFailure(
			new Error("rate limit; secret-api-key", {
				cause: {
					responseBody: JSON.stringify({ error: "429 quota exceeded" }),
					statusCode: 429,
				},
			}),
			{ modelId: "gpt-5.6-luna", providerId: "openai" }
		);
		expect(failure).toEqual({
			code: "rate-limited",
			details: {
				modelId: "gpt-5.6-luna",
				providerId: "openai",
				statusCode: 429,
			},
			message: "The model provider rate-limited the request.",
			retry: "after-delay",
			source: "provider",
			version: 1,
		});
		expect(JSON.stringify(failure)).not.toContain("secret-api-key");
		expect(modelFailureSchema.safeParse(failure).success).toBe(true);
		expect(
			normalizeModelFailure({ ...failure, message: "private diagnostic" })
				.message
		).toBe("The model provider rate-limited the request.");

		expect(
			normalizeModelFailure(
				new Error("context_length_exceeded", {
					cause: {
						responseBody: JSON.stringify({ error: "private details" }),
					},
				})
			).code
		).toBe("context-overflow");
		expect(
			normalizeModelFailure({ message: "unauthorized", statusCode: 401 }).code
		).toBe("authentication");
	});

	test("unwraps stream error envelopes before classifying failures", () => {
		expect(
			normalizeModelFailure({
				error: { message: "bad request", statusCode: 400 },
			}).code
		).toBe("invalid-request");
	});
});
