import { describe, expect, test } from "bun:test";
import {
	classifyProviderError,
	isContextOverflowError,
} from "./provider-error";

describe("provider context overflow classification", () => {
	test("recognizes provider context-length errors in nested response bodies", () => {
		const error = new Error("Request failed", {
			cause: {
				responseBody: JSON.stringify({
					error: { code: "context_length_exceeded" },
				}),
			},
		});

		expect(isContextOverflowError(error)).toBe(true);
		expect(classifyProviderError(error)).toBe("context-overflow");
	});

	test("does not classify authentication, rate, or network failures as overflow", () => {
		for (const message of [
			"Unauthorized",
			"Rate limit exceeded",
			"Network request failed",
			"Model is unavailable",
		]) {
			expect(classifyProviderError(new Error(message))).toBe("other");
		}
	});

	test("recognizes common prompt-size wording", () => {
		expect(isContextOverflowError(new Error("The prompt is too long"))).toBe(
			true
		);
		expect(isContextOverflowError(new Error("invalid API key"))).toBe(false);
	});
});
