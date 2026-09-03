import { describe, expect, test } from "bun:test";
import { getDisplayMessage } from "./error-message";

describe("getDisplayMessage", () => {
	test("shows an OpenAI response error message", () => {
		const error = Object.assign(new Error("Bad Request"), {
			responseBody: JSON.stringify({
				error: { message: "ChatGPT account ID is required." },
			}),
		});

		expect(getDisplayMessage(error)).toBe("The model rejected the request.");
	});
	test("maps authenticated provider failures to the reconnect guidance", () => {
		const error = Object.assign(new Error("Unauthorized"), {
			responseBody: '{"error":"private auth detail"}',
			statusCode: 401,
		});

		expect(getDisplayMessage(error)).toBe(
			"Wincode session invalid or expired. Run /connect to sign in again."
		);
	});

	test("keeps a regular error message", () => {
		expect(getDisplayMessage(new Error("Connection failed."))).toBe(
			"Connection failed."
		);
	});
	test("renders a safe message for an Operational Failure", () => {
		expect(
			getDisplayMessage({
				code: "rate-limited",
				details: { providerId: "openai", statusCode: 429 },
				message: "raw provider response with secret-token",
				retry: "after-delay",
				source: "model",
				version: 1,
			})
		).toBe("The model provider rate-limited the request.");
	});
});
