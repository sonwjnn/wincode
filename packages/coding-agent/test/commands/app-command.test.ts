import { describe, expect, test } from "bun:test";
import { copyBrowserAuthorizationUrl } from "@/tui/commands/browser-authorization";
import { createRecordingClipboard } from "../support/clipboard";

describe("copyBrowserAuthorizationUrl", () => {
	test("writes the authorization URL through the clipboard service", async () => {
		const clipboard = createRecordingClipboard();

		await copyBrowserAuthorizationUrl(
			clipboard,
			"https://auth.openai.com/oauth/authorize"
		);

		expect(clipboard.writes).toEqual([
			"https://auth.openai.com/oauth/authorize",
		]);
	});

	test("reports a failed write as a URL-specific error", async () => {
		const clipboard = createRecordingClipboard(async () => {
			throw new Error("host failed");
		});

		await expect(
			copyBrowserAuthorizationUrl(
				clipboard,
				"https://auth.openai.com/oauth/authorize"
			)
		).rejects.toThrow("Failed to copy URL.");
	});
});
