import { env } from "@wincode/env/cli";
import { serve } from "bun";
import {
	allowInsecureRequests,
	authorizationCodeGrantRequest,
	calculatePKCECodeChallenge,
	discoveryRequest,
	generateRandomCodeVerifier,
	generateRandomState,
	None,
	processAuthorizationCodeResponse,
	processDiscoveryResponse,
	validateAuthResponse,
} from "oauth4webapi";
import open from "open";
import type {
	AcquisitionProgress,
	ConnectionProgress,
	WincodeCredential,
} from "./contract";

export type { ConnectionProgress } from "./contract";

const DEFAULT_REDIRECT_URI = "http://127.0.0.1:8765/callback";
const DEFAULT_CLIENT_ID = "wincode-cli";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OAUTH_SCOPE = "openid profile email offline_access chat:write";

export type ConnectWincodeBrowserOptions = {
	browser?: (url: string) => Promise<void>;
	clientId?: string;
	openBrowser?: boolean;
	signal?: AbortSignal;
	deps?: Partial<{
		authorizationCodeGrantRequest: typeof authorizationCodeGrantRequest;
		calculatePKCECodeChallenge: typeof calculatePKCECodeChallenge;
		discoveryRequest: typeof discoveryRequest;
		generateRandomCodeVerifier: typeof generateRandomCodeVerifier;
		generateRandomState: typeof generateRandomState;
		open: typeof open;
		processAuthorizationCodeResponse: typeof processAuthorizationCodeResponse;
		processDiscoveryResponse: typeof processDiscoveryResponse;
		serve: typeof serve;
		validateAuthResponse: typeof validateAuthResponse;
	}>;
	issuer: string;
	resource?: string;
	onAuthorizationUrl?: (authorizationUrl: URL) => void;
	onStatus?: (status: ConnectionProgress) => void;
	redirectUri?: string;
	timeoutMs?: number;
};

export function getWincodeBrowserConfig(): {
	clientId: string;
	issuer: string;
	redirectUri: string;
	resource: string;
} {
	const serverUrl = env.WINCODE_OAUTH_ISSUER ?? env.SERVER_URL;
	if (!serverUrl) {
		throw new Error("WINCODE_OAUTH_ISSUER is required for browser sign-in.");
	}
	return getWincodeBrowserConfigFromServerUrl(serverUrl);
}

export function getWincodeBrowserConfigFromServerUrl(serverUrl: string): {
	clientId: string;
	issuer: string;
	redirectUri: string;
	resource: string;
} {
	const redirectUri = env.WINCODE_OAUTH_REDIRECT_URI ?? DEFAULT_REDIRECT_URI;
	validateRedirectUri(redirectUri);
	return {
		clientId: env.WINCODE_OAUTH_CLIENT_ID ?? DEFAULT_CLIENT_ID,
		issuer: new URL("/api/auth", serverUrl).href,
		redirectUri,
		resource: new URL("/api", serverUrl).href,
	};
}

export async function acquireWincodeBrowserCredential(
	options: Omit<ConnectWincodeBrowserOptions, "backend" | "onStatus"> & {
		onStatus?: (status: AcquisitionProgress) => void;
	}
): Promise<Extract<WincodeCredential, { kind: "oauth-session" }>> {
	const config = {
		clientId: options.clientId ?? DEFAULT_CLIENT_ID,
		issuer: options.issuer,
		redirectUri: options.redirectUri ?? DEFAULT_REDIRECT_URI,
		resource: options.resource ?? new URL("/api", options.issuer).href,
	};
	validateRedirectUri(config.redirectUri);
	const deps = options.deps ?? {};
	const callbackServer = startCallbackServer(
		config.redirectUri,
		deps.serve ?? serve
	);
	try {
		const issuer = new URL(config.issuer);
		const insecureRequestOptions = isLoopbackHttpIssuer(issuer)
			? { [allowInsecureRequests]: true }
			: undefined;
		const discoveryResponse = await (deps.discoveryRequest ?? discoveryRequest)(
			issuer,
			{ algorithm: "oauth2", signal: options.signal, ...insecureRequestOptions }
		);
		const authorizationServer = await (
			deps.processDiscoveryResponse ?? processDiscoveryResponse
		)(issuer, discoveryResponse);
		const codeVerifier = (
			deps.generateRandomCodeVerifier ?? generateRandomCodeVerifier
		)();
		const codeChallenge = await (
			deps.calculatePKCECodeChallenge ?? calculatePKCECodeChallenge
		)(codeVerifier);
		const state = (deps.generateRandomState ?? generateRandomState)();
		const authorizationUrl = createAuthorizationUrl({
			authorizationEndpoint: authorizationServer.authorization_endpoint,
			clientId: config.clientId,
			codeChallenge,
			redirectUri: config.redirectUri,
			resource: config.resource,
			state,
		});
		options.onAuthorizationUrl?.(authorizationUrl);
		const shouldOpenBrowser = options.openBrowser ?? true;
		if (shouldOpenBrowser) {
			options.onStatus?.("opening-browser");
			await (options.browser ?? deps.open ?? open)(authorizationUrl.href);
		}
		options.onStatus?.("waiting-for-callback");
		const callbackUrl = await callbackServer.waitForCallback(
			options.timeoutMs ?? LOGIN_TIMEOUT_MS,
			options.signal
		);
		if (callbackUrl.searchParams.has("error")) {
			throw new Error(
				"Browser sign-in cancelled by provider. Try /connect again."
			);
		}
		const client = { client_id: config.clientId };
		const callbackParameters = (
			deps.validateAuthResponse ?? validateAuthResponse
		)(authorizationServer, client, callbackUrl, state);
		options.onStatus?.("exchanging-token");
		const response = await (
			deps.authorizationCodeGrantRequest ?? authorizationCodeGrantRequest
		)(
			authorizationServer,
			client,
			None(),
			callbackParameters,
			config.redirectUri,
			codeVerifier,
			{
				...insecureRequestOptions,
				signal: options.signal,
				additionalParameters: { resource: config.resource },
			}
		);
		const tokenResponse = await (
			deps.processAuthorizationCodeResponse ?? processAuthorizationCodeResponse
		)(authorizationServer, client, response);
		options.signal?.throwIfAborted();
		return createStoredSession(tokenResponse, config);
	} finally {
		callbackServer.stop();
	}
}

export function isLoopbackHttpIssuer(issuer: URL): boolean {
	return (
		issuer.protocol === "http:" &&
		(issuer.hostname === "127.0.0.1" ||
			issuer.hostname === "::1" ||
			issuer.hostname === "localhost")
	);
}

export function createAuthorizationUrl({
	authorizationEndpoint,
	clientId,
	codeChallenge,
	redirectUri,
	resource,
	state,
}: {
	authorizationEndpoint: string | undefined;
	clientId: string;
	codeChallenge: string;
	redirectUri: string;
	resource: string;
	state: string;
}): URL {
	if (!authorizationEndpoint) {
		throw new Error("OAuth issuer did not publish an authorization endpoint.");
	}
	const authorizationUrl = new URL(authorizationEndpoint);
	authorizationUrl.searchParams.set("client_id", clientId);
	authorizationUrl.searchParams.set("code_challenge", codeChallenge);
	authorizationUrl.searchParams.set("code_challenge_method", "S256");
	authorizationUrl.searchParams.set("redirect_uri", redirectUri);
	authorizationUrl.searchParams.set("resource", resource);
	authorizationUrl.searchParams.set("response_type", "code");
	authorizationUrl.searchParams.set("scope", OAUTH_SCOPE);
	authorizationUrl.searchParams.set("state", state);
	return authorizationUrl;
}

function createStoredSession(
	tokenResponse: {
		access_token: string;
		expires_in?: number;
		refresh_token?: string;
		scope?: string;
		token_type: string;
	},
	config: { clientId: string; issuer: string; resource: string }
): Extract<WincodeCredential, { kind: "oauth-session" }> {
	if (!tokenResponse.refresh_token) {
		throw new Error("OAuth server did not return a refresh token.");
	}
	if (!tokenResponse.expires_in || tokenResponse.expires_in <= 0) {
		throw new Error("OAuth server did not return a valid token expiry.");
	}
	if (tokenResponse.token_type.toLowerCase() !== "bearer") {
		throw new Error("OAuth server returned an unsupported token type.");
	}
	const now = new Date();
	return {
		accessToken: tokenResponse.access_token,
		clientId: config.clientId,
		expiresAt: new Date(
			now.getTime() + tokenResponse.expires_in * 1000
		).toISOString(),
		issuer: config.issuer,
		kind: "oauth-session",
		refreshToken: tokenResponse.refresh_token,
		resource: config.resource,
		scope: tokenResponse.scope ?? OAUTH_SCOPE,
		tokenType: "Bearer",
		updatedAt: now.toISOString(),
	};
}

function validateRedirectUri(redirectUri: string): void {
	const url = new URL(redirectUri);
	if (
		url.protocol !== "http:" ||
		url.hostname !== "127.0.0.1" ||
		url.pathname !== "/callback" ||
		!url.port ||
		Number(url.port) === 0
	) {
		throw new Error(
			"WINCODE_OAUTH_REDIRECT_URI must be an http://127.0.0.1:<port>/callback URL."
		);
	}
}

type CallbackServer = {
	stop: () => void;
	waitForCallback: (timeoutMs: number, signal?: AbortSignal) => Promise<URL>;
};

function startCallbackServer(
	redirectUri: string,
	serveImpl: typeof serve
): CallbackServer {
	validateRedirectUri(redirectUri);
	const callbackUrl = new URL(redirectUri);
	let resolveCallback: ((url: URL) => void) | undefined;
	let receivedCallback = false;
	const callbackPromise = new Promise<URL>((resolve) => {
		resolveCallback = resolve;
	});
	const server = serveImpl({
		fetch(request) {
			const requestUrl = new URL(request.url);
			if (
				requestUrl.origin !== callbackUrl.origin ||
				requestUrl.pathname !== callbackUrl.pathname ||
				receivedCallback
			) {
				return new Response("Not found", { status: 404 });
			}
			receivedCallback = true;
			resolveCallback?.(requestUrl);
			return new Response(
				'<!doctype html><html><head><meta charset="utf-8"><title>Wincode</title><style>html,body{margin:0;min-height:100%;background:#000;color:#fff;font-family:sans-serif}body{display:flex;align-items:center;justify-content:center;padding:24px;text-align:center}</style></head><body><p>Connected. You can close this tab.</p></body></html>',
				{ headers: { "content-type": "text/html; charset=utf-8" } }
			);
		},
		hostname: "127.0.0.1",
		port: Number(callbackUrl.port),
	});
	return {
		stop: () => server.stop(false),
		waitForCallback: (timeoutMs, signal) =>
			new Promise<URL>((resolve, reject) => {
				let settled = false;
				let abortListenerAttached = false;
				const cleanup = () => {
					clearTimeout(timeout);
					if (abortListenerAttached) {
						signal?.removeEventListener("abort", onAbort);
					}
					abortListenerAttached = false;
				};
				const finish = (handler: () => void): void => {
					if (settled) {
						return;
					}
					settled = true;
					cleanup();
					handler();
				};
				const onAbort = () => {
					finish(() => {
						server.stop(false);
						reject(new Error("Browser sign-in aborted."));
					});
				};
				const timeout = setTimeout(() => {
					finish(() => reject(new Error("Browser sign-in timed out.")));
				}, timeoutMs).unref();
				if (signal?.aborted) {
					onAbort();
					return;
				}
				signal?.addEventListener("abort", onAbort, { once: true });
				abortListenerAttached = true;
				callbackPromise.then((url) => {
					finish(() => resolve(url));
				});
			}),
	};
}
