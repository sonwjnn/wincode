import { describe, expect, test } from "bun:test";
import { getDisplayMessage } from "@/modules/sessions/ui/messages/error-message";

describe("getDisplayMessage", () => {
	test("shows an OpenAI response error message", () => {
		const error = Object.assign(new Error("Bad Request"), {
			responseBody: JSON.stringify({
				error: { message: "ChatGPT account ID is required." },
			}),
		});

		expect(getDisplayMessage(error)).toBe("The model rejected the request.");
	});
	test("does not label Provider authentication failures as expired Wincode login", () => {
		const error = Object.assign(new Error("Unauthorized"), {
			responseBody: '{"error":"private auth detail"}',
			statusCode: 401,
		});

		expect(getDisplayMessage(error)).toBe(
			"Provider authentication failed. Check the selected Provider connection in /connect."
		);
		expect(getDisplayMessage(error)).not.toContain("private auth detail");
	});

	test("identifies the affected Provider Model for operational authentication failure", () => {
		expect(
			getDisplayMessage({
				code: "authentication",
				details: { modelId: "gpt-test", providerId: "openai" },
				message: "Model authentication failed.",
				retry: "never",
				source: "model",
				version: 1,
			})
		).toBe(
			"Authentication failed for openai/gpt-test. Check that Provider connection in /connect."
		);
	});

	test("uses neutral connection guidance for an unclassified unauthorized error", () => {
		expect(getDisplayMessage(new Error("Unauthorized"))).toBe(
			"Authentication failed. Check the relevant account or Provider connection in /connect."
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
