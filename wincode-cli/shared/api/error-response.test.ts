import { describe, expect, test } from "bun:test";
import { getErrorMessage } from "./error-response";

describe("getErrorMessage", () => {
	test("returns non-empty error payload message", async () => {
		const message = await getErrorMessage({
			json: async () => ({ error: "Session not found" }),
			status: 404,
			statusText: "Not Found",
		});

		expect(message).toBe("Session not found");
	});

	test("falls back to status text for invalid error payload", async () => {
		const message = await getErrorMessage({
			json: async () => ({ error: "" }),
			status: 500,
			statusText: "Internal Server Error",
		});

		expect(message).toBe("Internal Server Error");
	});

	test("falls back to status code when status text is empty", async () => {
		const message = await getErrorMessage({
			json: () => Promise.reject(new Error("Invalid JSON")),
			status: 502,
			statusText: "",
		});

		expect(message).toBe("Request failed with status 502");
	});
});
