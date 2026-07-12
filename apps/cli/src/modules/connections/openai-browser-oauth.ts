import { serve } from "bun";
import {
	calculatePKCECodeChallenge,
	generateRandomCodeVerifier,
	generateRandomState,
} from "oauth4webapi";
import open from "open";
import type { ConnectionsBackend } from "./storage";
import type { OpenAICredential } from "./types";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_AUTHORIZE_PATH = "/oauth/authorize";
const OPENAI_TOKEN_PATH = "/oauth/token";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_SCOPE = "openid profile email offline_access";
const OPENAI_AUTH_PARAMS = {
	codex_cli_simplified_flow: "true",
	id_token_add_organizations: "true",
	originator: "wincode",
} as const;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const OPENAI_REFRESH_SKEW_MS = 5 * 60 * 1000;

type BrowserStatus =
	| "opening-browser"
	| "waiting-for-callback"
	| "exchanging-token"
	| "connected";

type TokenResponse = {
	access_token: string;
	expires_in?: number;
	id_token?: string;
	refresh_token?: string;
	token_type: string;
};

type RefreshState = { promise?: Promise<OpenAICredential> };
const refreshStates = new WeakMap<ConnectionsBackend, RefreshState>();

export type OpenAIBrowserConnectOptions = {
	backend: ConnectionsBackend;
	browser?: (url: string) => Promise<void>;
	openBrowser?: boolean;
	signal?: AbortSignal;
	onAuthorizationUrl?: (authorizationUrl: URL) => void;
	onStatus?: (status: BrowserStatus) => void;
	timeoutMs?: number;
	deps?: Partial<{
		calculatePKCECodeChallenge: typeof calculatePKCECodeChallenge;
		generateRandomCodeVerifier: typeof generateRandomCodeVerifier;
		generateRandomState: typeof generateRandomState;
		open: typeof open;
		serve: typeof serve;
	}>;
};

export const connectOpenAIBrowser = async (
	options: OpenAIBrowserConnectOptions
): Promise<void> => {
	const deps = options.deps ?? {};
	const verifier = (
		deps.generateRandomCodeVerifier ?? generateRandomCodeVerifier
	)();
	const challenge = await (
		deps.calculatePKCECodeChallenge ?? calculatePKCECodeChallenge
	)(verifier);
	const state = (deps.generateRandomState ?? generateRandomState)();
	const callbackServer = startCallbackServer(deps.serve ?? serve);
	try {
		const authorizationUrl = createOpenAIAuthorizationUrl(challenge, state);
		options.onAuthorizationUrl?.(authorizationUrl);
		if (options.openBrowser ?? true) {
			options.onStatus?.("opening-browser");
			await (options.browser ?? deps.open ?? open)(authorizationUrl.href);
		}
		options.onStatus?.("waiting-for-callback");
		const callbackUrl = await callbackServer.waitForCallback(
			options.timeoutMs ?? LOGIN_TIMEOUT_MS,
			options.signal
		);
		if (callbackUrl.searchParams.get("state") !== state) {
			throw new Error("OpenAI OAuth state mismatch.");
		}
		const code = callbackUrl.searchParams.get("code");
		if (!code) {
			throw new Error("OpenAI OAuth callback missing code.");
		}
		options.onStatus?.("exchanging-token");
		const token = await exchangeToken({ code, verifier });
		const credential = createOpenAICredential(token);
		await options.backend.replaceValidated("openai", credential);
		options.onStatus?.("connected");
	} finally {
		callbackServer.stop();
	}
};

export const refreshOpenAICredential = async (
	backend: ConnectionsBackend,
	credential: Extract<OpenAICredential, { kind: "oauth-session" }>
): Promise<OpenAICredential> => {
	if (!isNearExpiry(credential.expiresAt)) {
		return credential;
	}
	const state = refreshStates.get(backend) ?? {};
	refreshStates.set(backend, state);
	state.promise ??= doRefresh(backend, credential).finally(() => {
		state.promise = undefined;
	});
	return state.promise;
};

function createOpenAIAuthorizationUrl(
	codeChallenge: string,
	state: string
): URL {
	const url = new URL(OPENAI_AUTHORIZE_PATH, OPENAI_ISSUER);
	url.searchParams.set("client_id", OPENAI_CLIENT_ID);
	url.searchParams.set("code_challenge", codeChallenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("redirect_uri", OPENAI_REDIRECT_URI);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", OPENAI_SCOPE);
	url.searchParams.set("state", state);
	for (const [key, value] of Object.entries(OPENAI_AUTH_PARAMS)) {
		url.searchParams.set(key, value);
	}
	return url;
}

async function exchangeToken(input: {
	code: string;
	verifier: string;
}): Promise<TokenResponse> {
	const form = new URLSearchParams({
		client_id: OPENAI_CLIENT_ID,
		code: input.code,
		code_verifier: input.verifier,
		grant_type: "authorization_code",
		redirect_uri: OPENAI_REDIRECT_URI,
	});
	const response = await fetch(new URL(OPENAI_TOKEN_PATH, OPENAI_ISSUER), {
		body: form,
		method: "POST",
	});
	if (!response.ok) {
		throw new Error("OpenAI OAuth token exchange failed.");
	}
	return (await response.json()) as TokenResponse;
}

async function doRefresh(
	backend: ConnectionsBackend,
	credential: Extract<OpenAICredential, { kind: "oauth-session" }>
): Promise<OpenAICredential> {
	try {
		const form = new URLSearchParams({
			client_id: OPENAI_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credential.refreshToken,
		});
		const response = await fetch(new URL(OPENAI_TOKEN_PATH, OPENAI_ISSUER), {
			body: form,
			method: "POST",
		});
		if (!response.ok) {
			throw new Error("OpenAI OAuth refresh failed.");
		}
		const token = (await response.json()) as TokenResponse;
		const next = createOpenAICredential(token, credential.refreshToken);
		await backend.replaceValidated("openai", next);
		return next;
	} catch {
		throw new Error("Reconnect OpenAI with /connect");
	}
}

const isNearExpiry = (expiresAt: string): boolean =>
	Date.parse(expiresAt) - Date.now() <= OPENAI_REFRESH_SKEW_MS;

function createOpenAICredential(
	token: TokenResponse,
	previousRefreshToken?: string
): OpenAICredential {
	if (
		!token.access_token ||
		token.expires_in === undefined ||
		token.expires_in <= 0
	) {
		throw new Error("OpenAI OAuth server returned an invalid token response.");
	}
	const now = new Date();
	return {
		accessToken: token.access_token,
		accountId: extractAccountId(token.id_token ?? token.access_token),
		expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
		kind: "oauth-session",
		refreshToken: token.refresh_token ?? previousRefreshToken ?? "",
		updatedAt: now.toISOString(),
	};
}

function extractAccountId(jwt: string | undefined): string | undefined {
	if (!jwt) {
		return;
	}
	try {
		const payload = JSON.parse(
			Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")
		) as Record<string, unknown>;
		const direct = payload.chatgpt_account_id;
		if (typeof direct === "string") {
			return direct;
		}
		const nested = payload["https://api.openai.com/auth"];
		if (
			nested &&
			typeof nested === "object" &&
			typeof (nested as Record<string, unknown>).chatgpt_account_id === "string"
		) {
			return (nested as Record<string, string>).chatgpt_account_id;
		}
		const organizations = payload.organizations;
		if (
			Array.isArray(organizations) &&
			organizations[0] &&
			typeof organizations[0] === "object" &&
			typeof (organizations[0] as Record<string, unknown>).id === "string"
		) {
			return (organizations[0] as Record<string, string>).id;
		}
	} catch {
		return;
	}
	return;
}

type CallbackServer = {
	stop: () => void;
	waitForCallback: (timeoutMs: number, signal?: AbortSignal) => Promise<URL>;
};

function startCallbackServer(serveImpl: typeof serve): CallbackServer {
	const callbackUrl = new URL(OPENAI_REDIRECT_URI);
	let resolveCallback: ((url: URL) => void) | undefined;
	let received = false;
	const callbackPromise = new Promise<URL>((resolve) => {
		resolveCallback = resolve;
	});
	const server = serveImpl({
		fetch(request) {
			const requestUrl = new URL(request.url);
			if (
				received ||
				requestUrl.origin !== callbackUrl.origin ||
				requestUrl.pathname !== callbackUrl.pathname
			) {
				return new Response("Not found", { status: 404 });
			}
			received = true;
			resolveCallback?.(requestUrl);
			return new Response(
				"<title>OpenAI</title><p>Connected. You can close this tab.</p>",
				{ headers: { "content-type": "text/html; charset=utf-8" } }
			);
		},
		hostname: callbackUrl.hostname,
		port: Number(callbackUrl.port),
	});
	return {
		stop: () => server.stop(false),
		waitForCallback: (timeoutMs, signal) =>
			new Promise((resolve, reject) => {
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
