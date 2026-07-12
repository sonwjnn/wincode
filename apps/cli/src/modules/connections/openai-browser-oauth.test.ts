import { describe, expect, mock, test } from "bun:test";
import { connectOpenAIBrowser } from "./openai-browser-oauth";

describe("connectOpenAIBrowser", () => {
	test("rejects state mismatch and preserves existing credential", async () => {
		let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
		const backend = {
			async replaceValidated() {
				throw new Error("should not persist");
			},
		};
		const browser = mock(async (_url: string) => {
			await fetchHandler?.(
				new Request("http://localhost:1455/auth/callback?code=code&state=wrong")
			);
		});
		await expect(
			connectOpenAIBrowser({
				backend: backend as never,
				browser,
				deps: {
					calculatePKCECodeChallenge: async () => "challenge",
					generateRandomCodeVerifier: () => "verifier",
					generateRandomState: () => "state",
					open: browser as never,
					serve: ((server: {
						fetch: (request: Request) => Promise<Response>;
					}) => {
						fetchHandler = server.fetch;
						return { stop: () => undefined } as never;
					}) as never,
				},
				timeoutMs: 100,
			})
		).rejects.toThrow("OpenAI OAuth state mismatch.");
	});

	test("does not open browser when disabled", async () => {
		const browser = mock(async () => undefined);
		const controller = new AbortController();
		const stop = mock(() => undefined);
		const promise = connectOpenAIBrowser({
			backend: { replaceValidated: async () => undefined } as never,
			browser,
			deps: {
				calculatePKCECodeChallenge: async () => "challenge",
				generateRandomCodeVerifier: () => "verifier",
				generateRandomState: () => "state",
				serve: (() => ({ stop })) as never,
			},
			openBrowser: false,
			signal: controller.signal,
			timeoutMs: 100,
		});

		controller.abort();
		await expect(promise).rejects.toThrow("Browser sign-in aborted.");
		expect(browser).not.toHaveBeenCalled();
		expect(stop.mock.calls.length).toBeGreaterThanOrEqual(1);
	});

	test("default opens browser", async () => {
		const browser = mock(async () => undefined);
		const controller = new AbortController();
		const promise = connectOpenAIBrowser({
			backend: { replaceValidated: async () => undefined } as never,
			browser,
			deps: {
				calculatePKCECodeChallenge: async () => "challenge",
				generateRandomCodeVerifier: () => "verifier",
				generateRandomState: () => "state",
				serve: (() => ({ stop: () => undefined })) as never,
			},
			signal: controller.signal,
			timeoutMs: 100,
		});

		controller.abort();
		await expect(promise).rejects.toThrow();
		expect(browser).toHaveBeenCalledTimes(1);
	});
});
