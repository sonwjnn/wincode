import { describe, expect, mock, test } from "bun:test";
import {
	acquireOpenAIBrowserCredential,
	refreshOpenAIOAuthCredential,
} from "./openai-browser-oauth";

describe("openai browser oauth primitives", () => {
	test("rejects state mismatch", async () => {
		let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
		const browser = mock(async (_url: string) => {
			await fetchHandler?.(
				new Request("http://localhost:1455/auth/callback?code=code&state=wrong")
			);
		});
		await expect(
			acquireOpenAIBrowserCredential({
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

	test("refresh skips fresh token", async () => {
		const credential = {
			accessToken: "old",
			accountId: "acct",
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			kind: "oauth-session" as const,
			refreshToken: "refresh",
			updatedAt: new Date().toISOString(),
		};
		expect(await refreshOpenAIOAuthCredential(credential)).toBe(credential);
	});

	test("rejects malformed token response with stable error", async () => {
		let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
		const browser = mock(async (_url: string) => {
			await fetchHandler?.(
				new Request("http://localhost:1455/auth/callback?code=code&state=state")
			);
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/oauth/token")) {
				return new Response(
					JSON.stringify({ access_token: "a", expires_in: 0 }),
					{
						status: 200,
					}
				);
			}
			return new Response(null, { status: 404 });
		}) as never;
		try {
			await expect(
				acquireOpenAIBrowserCredential({
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
					openBrowser: true,
					timeoutMs: 100,
				})
			).rejects.toThrow(
				"OpenAI OAuth server returned an invalid token response."
			);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rejects malformed jwt payload with stable account error", async () => {
		let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
		const browser = mock(async (_url: string) => {
			await fetchHandler?.(
				new Request("http://localhost:1455/auth/callback?code=code&state=state")
			);
		});
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async (input) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url.includes("/oauth/token")) {
				return new Response(
					JSON.stringify({
						access_token: "a.b.c",
						expires_in: 60,
						refresh_token: "r",
						token_type: "Bearer",
					}),
					{ status: 200 }
				);
			}
			return new Response(null, { status: 404 });
		}) as never;
		try {
			await expect(
				acquireOpenAIBrowserCredential({
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
					openBrowser: true,
					timeoutMs: 100,
				})
			).rejects.toThrow("OpenAI OAuth credential missing account id.");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not open browser when disabled", async () => {
		const browser = mock(async () => undefined);
		const controller = new AbortController();
		const stop = mock(() => undefined);
		const promise = acquireOpenAIBrowserCredential({
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
		const promise = acquireOpenAIBrowserCredential({
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

	test("passes abort signal to token exchange and refresh", async () => {
		const fetchSignals: Array<AbortSignal | undefined> = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(async (_input, init) => {
			fetchSignals.push(init?.signal);
			return new Response(
				JSON.stringify({
					access_token: "a.b.c",
					expires_in: 60,
					refresh_token: "r",
					token_type: "Bearer",
				}),
				{ status: 200 }
			);
		}) as never;
		try {
			await refreshOpenAIOAuthCredential(
				{
					accessToken: "old",
					accountId: "acct",
					expiresAt: new Date(Date.now() - 1).toISOString(),
					kind: "oauth-session",
					refreshToken: "refresh",
					updatedAt: new Date().toISOString(),
				},
				new AbortController().signal
			);
			expect(fetchSignals[0]).toBeDefined();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
