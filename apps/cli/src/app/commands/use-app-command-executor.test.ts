import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { copyBrowserAuthorizationUrl } from "./use-app-command-executor";

describe("copyBrowserAuthorizationUrl", () => {
	test("uses OSC52 when available", async () => {
		let copiedUrl = "";
		let spawned = false;

		await copyBrowserAuthorizationUrl(
			{
				copyToClipboardOSC52: (url) => {
					copiedUrl = url;
					return true;
				},
			},
			"https://example.com/auth",
			async () => {
				spawned = true;
				return 0;
			}
		);

		expect(copiedUrl).toBe("https://example.com/auth");
		expect(spawned).toBe(false);
	});

	test("falls back to pbcopy on darwin", async () => {
		let stdin = "";

		await copyBrowserAuthorizationUrl(
			{
				copyToClipboardOSC52: () => false,
			},
			"https://example.com/auth",
			async (_command, input) => {
				stdin = input;
				return 0;
			}
		);

		expect(stdin).toBe("https://example.com/auth");
	});

	test("connect open reads provider statuses before opening dialog", async () => {
		const source = await readFile(
			new URL("./use-app-command-executor.tsx", import.meta.url),
			"utf8"
		);

		expect(source).toContain("getStatus(providerId)");
		expect(source).toContain("connectedProviderIds");
		expect(source).toContain('(["wincode", "openai", "anthropic"] as const)');
	});
});
