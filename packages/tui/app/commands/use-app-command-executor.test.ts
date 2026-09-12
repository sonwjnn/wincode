import { describe, expect, test } from "bun:test";
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
			"https://auth.openai.com/oauth/authorize",
			async () => {
				spawned = true;
				return 0;
			}
		);

		expect(copiedUrl).toBe("https://auth.openai.com/oauth/authorize");
		expect(spawned).toBe(false);
	});

	test("falls back to pbcopy on darwin", async () => {
		let stdin = "";

		await copyBrowserAuthorizationUrl(
			{
				copyToClipboardOSC52: () => false,
			},
			"https://auth.openai.com/oauth/authorize",
			async (_command, input) => {
				stdin = input;
				return 0;
			}
		);

		expect(stdin).toBe("https://auth.openai.com/oauth/authorize");
	});
});
