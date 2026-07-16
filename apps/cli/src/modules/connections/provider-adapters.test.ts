import { describe, expect, mock, test } from "bun:test";
import { createProviderAdapters } from "./provider-adapters";

const restoreFetch = async <T>(run: () => Promise<T>): Promise<T> => {
	const originalFetch = globalThis.fetch;
	try {
		return await run();
	} finally {
		globalThis.fetch = originalFetch;
	}
};

describe("provider adapters", () => {
	test("api key connect validates and writes nothing on failure", async () => {
		const validate = mock(async () => {
			throw new Error("bad key");
		});
		const adapters = createProviderAdapters({
			validateAnthropicApiKey: validate,
		});
		await expect(
			adapters.anthropic.connect({
				apiKey: "x",
				method: "api-key",
				providerId: "anthropic",
			})
		).rejects.toThrow("bad key");
	});

	test("production defaults validate api keys via fetch", async () => {
		await restoreFetch(async () => {
			const fetchMock = mock(async () => new Response(null, { status: 200 }));
			globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
			const adapters = createProviderAdapters({});
			await expect(
				adapters.google.connect({
					apiKey: "x",
					method: "api-key",
					providerId: "google",
				})
			).resolves.toEqual({ kind: "api-key", apiKey: "x" });
			expect(fetchMock).toHaveBeenCalled();
		});
	});

	test("openai browser forwards signal and status callbacks", async () => {
		const signal = new AbortController().signal;
		const statuses: string[] = [];
		const acquire = mock(async (request) => {
			request.onStatus?.("opening-browser");
			request.onStatus?.("waiting-for-callback");
			return {
				accessToken: "a",
				accountId: "acct",
				expiresAt: new Date().toISOString(),
				kind: "oauth-session" as const,
				refreshToken: "r",
				updatedAt: new Date().toISOString(),
			};
		});
		const adapters = createProviderAdapters({
			acquireOpenAIBrowserCredential: acquire,
		});
		await adapters.openai.connect({
			method: "browser",
			onAuthorizationUrl: () => undefined,
			onProgress: (status) => statuses.push(status),
			providerId: "openai",
			signal,
		});
		expect(acquire).toHaveBeenCalledWith(expect.objectContaining({ signal }));
		expect(statuses).toEqual(["opening-browser", "waiting-for-callback"]);
	});

	test("wincode browser uses config and acquisition primitive", async () => {
		const acquire = mock(async () => ({
			accessToken: "a",
			clientId: "client",
			expiresAt: new Date().toISOString(),
			expiresIn: 60,
			issuer: "https://issuer",
			kind: "oauth-session" as const,
			refreshToken: "r",
			resource: "https://res",
			scope: "s",
			tokenType: "Bearer" as const,
			updatedAt: new Date().toISOString(),
		}));
		const adapters = createProviderAdapters({
			acquireWincodeBrowserCredential: acquire,
		});
		await adapters.wincode.connect({
			method: "browser",
			providerId: "wincode",
			signal: new AbortController().signal,
			onAuthorizationUrl: () => undefined,
			onProgress: () => undefined,
		});
		expect(acquire).toHaveBeenCalled();
	});

	test("browser progress maps to primitive status for openai and wincode", async () => {
		const openaiStatuses: string[] = [];
		const wincodeStatuses: string[] = [];
		const adapters = createProviderAdapters({
			acquireOpenAIBrowserCredential: async (request) => {
				request.onStatus?.("opening-browser");
				return {
					accessToken: "a",
					accountId: "acct",
					expiresAt: new Date().toISOString(),
					kind: "oauth-session" as const,
					refreshToken: "r",
					updatedAt: new Date().toISOString(),
				};
			},
			acquireWincodeBrowserCredential: async (request) => {
				request.onStatus?.("opening-browser");
				request.onStatus?.("waiting-for-callback");
				return {
					accessToken: "a",
					clientId: "client",
					expiresAt: new Date().toISOString(),
					expiresIn: 60,
					issuer: "https://issuer",
					kind: "oauth-session" as const,
					refreshToken: "r",
					resource: "https://res",
					scope: "s",
					tokenType: "Bearer" as const,
					updatedAt: new Date().toISOString(),
				};
			},
		});
		await adapters.openai.connect({
			method: "browser",
			onAuthorizationUrl: () => undefined,
			onProgress: (status) => openaiStatuses.push(status),
			providerId: "openai",
			signal: new AbortController().signal,
		});
		await adapters.wincode.connect({
			method: "browser",
			onAuthorizationUrl: () => undefined,
			onProgress: (status) => wincodeStatuses.push(status),
			providerId: "wincode",
			signal: new AbortController().signal,
		});
		expect(openaiStatuses).toEqual(["opening-browser"]);
		expect(wincodeStatuses).toEqual([
			"opening-browser",
			"waiting-for-callback",
		]);
	});

	test("fresh oauth authorize no replacement", async () => {
		const adapters = createProviderAdapters({});
		const credential = {
			accessToken: "new",
			accountId: "acct",
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
			kind: "oauth-session" as const,
			refreshToken: "r",
			updatedAt: new Date().toISOString(),
		};
		const result = await adapters.openai.authorize(credential);
		expect(result.replacementCredential).toBeUndefined();
	});
});
