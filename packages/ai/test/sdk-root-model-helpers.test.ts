import { expect, test } from "bun:test";
import {
	formatModelTokenCount,
	MODEL_OUTPUT_TOKEN_LIMIT,
	normalizeModelFailure,
	normalizeModelUsage,
} from "@wincode/ai";

test("package root exposes shared model usage, failure, and output-limit helpers", () => {
	expect(MODEL_OUTPUT_TOKEN_LIMIT).toBe(32_000);
	expect(formatModelTokenCount(1234)).toBe("1.2K");
	expect(normalizeModelFailure).toBeTypeOf("function");
	expect(normalizeModelUsage({ inputTokens: 3, outputTokens: 1 })).toEqual({
		inputTokens: 3,
		outputTokens: 1,
	});
});
