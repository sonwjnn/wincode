import { describe, expect, test } from "bun:test";
import { getDisplayMessage } from "./error-message";

describe("getDisplayMessage", () => {
	test("shows an OpenAI response error message", () => {
		const error = Object.assign(new Error("Bad Request"), {
			responseBody: JSON.stringify({
				error: { message: "ChatGPT account ID is required." },
			}),
		});

		expect(getDisplayMessage(error)).toBe("ChatGPT account ID is required.");
	});

	test("keeps a regular error message", () => {
		expect(getDisplayMessage(new Error("Connection failed."))).toBe(
			"Connection failed."
		);
	});
});
