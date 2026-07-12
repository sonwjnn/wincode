import { describe, expect, test } from "bun:test";
import { getProviderErrorMessage } from "./error-message";

describe("getProviderErrorMessage", () => {
	test("extracts a nested provider response body", () => {
		const providerError = Object.assign(new Error("Bad Request"), {
			responseBody: JSON.stringify({
				error: { message: "Model is not supported." },
			}),
		});
		const wrappedError = new Error("Bad Request", { cause: providerError });

		expect(getProviderErrorMessage(wrappedError)).toBe(
			"Model is not supported."
		);
	});

	test("falls back to the deepest error message", () => {
		const wrappedError = new Error("Stream failed", {
			cause: new Error("Bad Request"),
		});

		expect(getProviderErrorMessage(wrappedError)).toBe("Bad Request");
	});
});
