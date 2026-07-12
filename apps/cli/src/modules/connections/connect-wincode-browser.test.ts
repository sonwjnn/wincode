import { describe, expect, mock, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
	connectWincodeBrowser,
	createAuthorizationUrl,
	getWincodeBrowserConfigFromServerUrl,
} from "./connect-wincode-browser";

describe("connectWincodeBrowser", () => {
	test("builds canonical issuer and resource from server url", () => {
		expect(getWincodeBrowserConfigFromServerUrl("https://example.com")).toEqual(
			{
				clientId: "wincode-cli",
				issuer: "https://example.com/api/auth",
				redirectUri: "http://127.0.0.1:8765/callback",
				resource: "https://example.com/api",
			}
		);
	});

	test("adds chat scope and resource to authorization url", () => {
		const url = createAuthorizationUrl({
			authorizationEndpoint: "https://auth.example.com/authorize",
			clientId: "wincode-cli",
			codeChallenge: "challenge",
			redirectUri: "http://127.0.0.1:8765/callback",
			resource: "https://example.com/api",
			state: "state",
		});

		expect(url.searchParams.get("resource")).toBe("https://example.com/api");
		expect(url.searchParams.get("scope")).toBe(
			"openid profile email offline_access chat:write"
		);
	});

	test("does not open browser when disabled", async () => {
		const browser = mock(async () => undefined);
		const controller = new AbortController();
		const stop = mock(() => undefined);
		const backend = {
			async replaceValidated() {
				throw new Error("should not persist");
			},
		};

		const promise = connectWincodeBrowser({
			backend: backend as never,
			browser,
			deps: {
				discoveryRequest: async () => ({}) as never,
				generateRandomCodeVerifier: () => "verifier",
				generateRandomState: () => "state",
				processDiscoveryResponse: async () =>
					({
						authorization_endpoint: "https://auth.example.com/authorize",
					}) as never,
				serve: (() => ({ stop })) as never,
			},
			issuer: "https://example.com/api/auth",
			onAuthorizationUrl: () => undefined,
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
		const backend = {
			async replaceValidated() {
				throw new Error("should not persist");
			},
		};

		const promise = connectWincodeBrowser({
			backend: backend as never,
			browser,
			deps: {
				discoveryRequest: async () => ({}) as never,
				generateRandomCodeVerifier: () => "verifier",
				generateRandomState: () => "state",
				processDiscoveryResponse: async () =>
					({
						authorization_endpoint: "https://auth.example.com/authorize",
					}) as never,
				serve: (() => ({ stop: () => undefined })) as never,
			},
			issuer: "https://example.com/api/auth",
			onAuthorizationUrl: () => undefined,
			signal: controller.signal,
			timeoutMs: 100,
		});

		controller.abort();
		await expect(promise).rejects.toThrow();
		expect(browser).toHaveBeenCalledTimes(1);
	});

	test("cancellation callback surfaces stable error and skips persistence", async () => {
		let fetchHandler: ((request: Request) => Promise<Response>) | undefined;
		const backend = {
			async replaceValidated() {
				throw new Error("should not persist");
			},
		};
		const promise = connectWincodeBrowser({
			backend: backend as never,
			deps: {
				discoveryRequest: async () => ({}) as never,
				generateRandomCodeVerifier: () => "verifier",
				generateRandomState: () => "state",
				processDiscoveryResponse: async () =>
					({
						authorization_endpoint: "https://auth.example.com/authorize",
					}) as never,
				serve: ((server: {
					fetch: (request: Request) => Promise<Response>;
				}) => {
					fetchHandler = server.fetch;
					return { stop: () => undefined } as never;
				}) as never,
				validateAuthResponse: () => {
					throw new Error("should not validate");
				},
			},
			issuer: "https://example.com/api/auth",
			onAuthorizationUrl: () => undefined,
			onStatus: () => undefined,
			timeoutMs: 100,
		});

		await fetchHandler?.(
			new Request("http://127.0.0.1:8765/callback?error=access_denied")
		);

		await expect(promise).rejects.toThrow(
			"Browser sign-in cancelled by provider. Try /connect again."
		);
	});

	test("callback html keeps black background and exact success copy", async () => {
		const source = await readFile(
			new URL("./connect-wincode-browser.ts", import.meta.url),
			"utf8"
		);

		expect(source).toContain("background:#000");
		expect(source).toContain("Connected. You can close this tab.");
		expect(source).not.toContain("window.close()");
	});
});
