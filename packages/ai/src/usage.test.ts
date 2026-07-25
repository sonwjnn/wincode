import { describe, expect, test } from "bun:test";
import type { LanguageModelUsage } from "ai";
import {
	buildUsageMessageMetadata,
	calculateUsageCostUsd,
	formatTokenCount,
	formatUsdAmount,
	getContextTokens,
	toCodingMessageUsage,
} from "./usage";

const fullUsage = (
	overrides: Partial<LanguageModelUsage> = {}
): LanguageModelUsage => ({
	inputTokenDetails: { noCacheTokens: 0 } as never,
	inputTokens: 1000,
	outputTokenDetails: { textTokens: 0 } as never,
	outputTokens: 200,
	totalTokens: 1200,
	...overrides,
});

describe("toCodingMessageUsage", () => {
	test("maps a complete LanguageModelUsage", () => {
		expect(
			toCodingMessageUsage(
				fullUsage({
					inputTokenDetails: {
						cacheReadTokens: 300,
						cacheWriteTokens: 50,
						noCacheTokens: 650,
					},
					inputTokens: 1000,
					outputTokenDetails: { reasoningTokens: 80, textTokens: 120 },
					outputTokens: 200,
					totalTokens: 1200,
				})
			)
		).toEqual({
			cacheReadTokens: 300,
			cacheWriteTokens: 50,
			inputTokens: 1000,
			outputTokens: 200,
			reasoningTokens: 80,
			totalTokens: 1200,
		});
	});

	test("omits undefined optional fields", () => {
		expect(
			toCodingMessageUsage(
				fullUsage({
					inputTokenDetails: { noCacheTokens: 0 } as never,
					outputTokenDetails: { textTokens: 0 } as never,
					totalTokens: undefined,
				})
			)
		).toEqual({
			inputTokens: 1000,
			outputTokens: 200,
		});
	});

	test("returns null when input or output tokens are missing", () => {
		expect(
			toCodingMessageUsage({ inputTokens: 1 } as LanguageModelUsage)
		).toBeNull();
		expect(
			toCodingMessageUsage({ outputTokens: 1 } as LanguageModelUsage)
		).toBeNull();
		expect(toCodingMessageUsage(undefined)).toBeNull();
	});
});

describe("getContextTokens", () => {
	test("sums input and output tokens", () => {
		expect(getContextTokens({ inputTokens: 12_000, outputTokens: 500 })).toBe(
			12_500
		);
	});
});

describe("calculateUsageCostUsd", () => {
	test("returns null when cost is missing", () => {
		expect(
			calculateUsageCostUsd(null, { inputTokens: 1, outputTokens: 1 })
		).toBeNull();
		expect(
			calculateUsageCostUsd(undefined, { inputTokens: 1, outputTokens: 1 })
		).toBeNull();
	});

	test("multiplies uncached input, cache read, and output by their rates", () => {
		const cost = { cacheRead: 0.075, input: 0.75, output: 4.5 };
		const usage = {
			cacheReadTokens: 800_000,
			inputTokens: 1_000_000,
			outputTokens: 100_000,
		};
		// uncached input = 200_000 * 0.75 = 0.15
		// cache read    = 800_000 * 0.075 = 0.06
		// output        = 100_000 * 4.5  = 0.45
		expect(calculateUsageCostUsd(cost, usage)).toBeCloseTo(0.66, 10);
	});

	test("falls back to input rate when cacheRead rate is missing", () => {
		const cost = { input: 2, output: 10 };
		const usage = {
			cacheReadTokens: 500_000,
			inputTokens: 1_000_000,
			outputTokens: 0,
		};
		// cache read uses input rate: 500k @ $2 + 500k uncached @ $2 = $2.00
		expect(calculateUsageCostUsd(cost, usage)).toBeCloseTo(2.0, 10);
	});

	test("treats all input as uncached when cacheRead is absent", () => {
		const cost = { input: 3, output: 15 };
		const usage = { inputTokens: 1_000_000, outputTokens: 0 };
		expect(calculateUsageCostUsd(cost, usage)).toBeCloseTo(3, 10);
	});
});

describe("formatTokenCount", () => {
	test("returns raw integer below 1k", () => {
		expect(formatTokenCount(0)).toBe("0");
		expect(formatTokenCount(999)).toBe("999");
	});

	test("formats thousands with one decimal", () => {
		expect(formatTokenCount(34_300)).toBe("34.3K");
		expect(formatTokenCount(1000)).toBe("1K");
		expect(formatTokenCount(99_500)).toBe("99.5K");
	});

	test("drops trailing .0", () => {
		expect(formatTokenCount(10_000)).toBe("10K");
	});

	test("formats large K as integer when ≥ 100", () => {
		expect(formatTokenCount(150_000)).toBe("150K");
	});

	test("formats millions", () => {
		expect(formatTokenCount(1_200_000)).toBe("1.2M");
		expect(formatTokenCount(2_000_000)).toBe("2M");
	});
});

describe("formatUsdAmount", () => {
	test("renders zero", () => {
		expect(formatUsdAmount(0)).toBe("$0.00");
	});

	test("renders sub-cent amounts as <$0.01", () => {
		expect(formatUsdAmount(0.0001)).toBe("<$$0.01".replace("$$", "$"));
		expect(formatUsdAmount(0.005)).toBe("<$$0.01".replace("$$", "$"));
	});

	test("renders cents and above with two decimals", () => {
		expect(formatUsdAmount(0.02)).toBe("$0.02");
		expect(formatUsdAmount(1.5)).toBe("$1.50");
	});
});

describe("buildUsageMessageMetadata", () => {
	test("returns undefined for non-finish parts", () => {
		expect(
			buildUsageMessageMetadata({
				part: { type: "text-delta", text: "hi" } as never,
			})
		).toBeUndefined();
	});

	test("extracts usage from the final finish part", () => {
		expect(
			buildUsageMessageMetadata({
				part: {
					totalUsage: { inputTokens: 10, outputTokens: 5 },
					type: "finish",
				} as never,
			})
		).toEqual({
			usage: { inputTokens: 10, outputTokens: 5 },
		});
	});

	test("returns undefined when finish part lacks usable usage", () => {
		expect(
			buildUsageMessageMetadata({
				part: { totalUsage: {}, type: "finish" } as never,
			})
		).toBeUndefined();
	});
});
