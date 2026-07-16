import { describe, expect, mock, test } from "bun:test";

mock.module("oauth4webapi", () => ({
	allowInsecureRequests: Symbol("allow"),
	calculatePKCECodeChallenge: mock(async () => "challenge"),
	discoveryRequest: mock(async () => new Response("{}")),
	generateRandomCodeVerifier: mock(() => "verifier"),
	generateRandomState: mock(() => "state"),
	processDiscoveryResponse: mock(async () => ({
		authorization_endpoint: "https://auth.example.com/authorize",
		token_endpoint: "https://auth.example.com/token",
	})),
	processAuthorizationCodeResponse: mock(async () => ({
		access_token: "access",
		expires_in: 60,
		refresh_token: "refresh",
		token_type: "Bearer",
	})),
	processRefreshTokenResponse: mock(async () => ({
		access_token: "next",
		expires_in: 60,
		token_type: "Bearer",
	})),
	refreshTokenGrantRequest: mock(
		async () => new Response("{}", { status: 200 })
	),
	None: () => undefined,
}));

describe("connection primitives", () => {
	test("openai acquire fails without refresh token or account id", async () => {
		const { acquireOpenAIBrowserCredential } = await import(
			"./openai-browser-oauth"
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						access_token: "access",
						expires_in: 60,
						token_type: "Bearer",
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;
		let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
		const browser = mock(async () => {
			await fetchHandler?.(
				new Request("http://localhost:1455/auth/callback?code=code&state=state")
			);
		});
		const serve = mock(
			(server: { fetch: (request: Request) => Promise<Response> }) => {
				fetchHandler = server.fetch;
				return { stop: () => undefined };
			}
		);
		await expect(
			acquireOpenAIBrowserCredential({
				browser,
				deps: {
					calculatePKCECodeChallenge: async () => "challenge",
					generateRandomCodeVerifier: () => "verifier",
					generateRandomState: () => "state",
					serve: serve as never,
				},
				onAuthorizationUrl: () => undefined,
				onStatus: () => undefined,
				signal: new AbortController().signal,
				timeoutMs: 1000,
			})
		).rejects.toThrow("OpenAI OAuth credential missing account id.");
		globalThis.fetch = originalFetch;
	});

	test("openai refresh skips fresh token", async () => {
		const { refreshOpenAIOAuthCredential } = await import(
			"./openai-browser-oauth"
		);
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

	test("openai refresh preserves account id when token omits claim", async () => {
		const { refreshOpenAIOAuthCredential } = await import(
			"./openai-browser-oauth"
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(
					JSON.stringify({
						access_token: "next",
						expires_in: 60,
						refresh_token: "rt2",
						token_type: "Bearer",
					}),
					{ status: 200 }
				)
		) as unknown as typeof fetch;
		const credential = {
			accessToken: "old",
			accountId: "acct",
			expiresAt: new Date(Date.now() - 600_000).toISOString(),
			kind: "oauth-session" as const,
			refreshToken: "refresh",
			updatedAt: new Date().toISOString(),
		};
		expect(await refreshOpenAIOAuthCredential(credential)).toEqual(
			expect.objectContaining({ accountId: "acct" })
		);
		globalThis.fetch = originalFetch;
	});

	test("wincode refresh skips fresh token", async () => {
		const { refreshWincodeOAuthCredential } = await import("./hosted-auth");
		const credential = {
			accessToken: "old",
			clientId: "client",
			kind: "oauth-session" as const,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			issuer: "https://example.com",
			refreshToken: "refresh",
			resource: "https://example.com/api",
			scope: "chat:write",
			tokenType: "Bearer" as const,
			updatedAt: new Date().toISOString(),
		};
		expect(await refreshWincodeOAuthCredential(credential)).toBe(credential);
	});

	test("openai refresh sanitizes failures", async () => {
		const { refreshOpenAIOAuthCredential } = await import(
			"./openai-browser-oauth"
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(
			async () =>
				new Response(JSON.stringify({ expires_in: 60, token_type: "Bearer" }), {
					status: 200,
				})
		) as unknown as typeof fetch;
		await expect(
			refreshOpenAIOAuthCredential({
				accessToken: "old",
				accountId: "acct",
				expiresAt: new Date(Date.now() - 600_000).toISOString(),
				kind: "oauth-session",
				refreshToken: "refresh",
				updatedAt: new Date().toISOString(),
			})
		).rejects.toThrow("Reconnect OpenAI with /connect");
		globalThis.fetch = originalFetch;
	});

	test("wincode refresh sanitizes failures", async () => {
		const { refreshWincodeOAuthCredential } = await import("./hosted-auth");
		await expect(
			refreshWincodeOAuthCredential({
				accessToken: "old",
				clientId: "client",
				kind: "oauth-session",
				expiresAt: new Date(Date.now() - 60_000).toISOString(),
				issuer: "not-a-url",
				refreshToken: "refresh",
				resource: "https://example.com/api",
				scope: "chat:write",
				tokenType: "Bearer",
				updatedAt: new Date().toISOString(),
			})
		).rejects.toThrow("Reconnect Wincode with /connect");
	});
});
