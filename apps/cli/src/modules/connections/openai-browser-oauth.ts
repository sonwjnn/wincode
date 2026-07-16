import { serve } from "bun";
import {
	calculatePKCECodeChallenge,
	generateRandomCodeVerifier,
	generateRandomState,
} from "oauth4webapi";
import open from "open";
import { z } from "zod";
import type {
	AcquisitionProgress,
	ConnectionProgress,
	OpenAICredential,
} from "./contract";

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

const tokenResponseSchema = z
	.object({
		access_token: z.string().min(1),
		expires_in: z.number().int().positive(),
		id_token: z.string().min(1).optional(),
		refresh_token: z.string().min(1).optional(),
		token_type: z.string().min(1),
	})
	.passthrough();

const jwtPayloadSchema = z
	.object({
		chatgpt_account_id: z.string().min(1).optional(),
		organizations: z
			.array(
				z
					.object({
						id: z.string().min(1),
					})
					.passthrough()
			)
			.optional(),
		"https://api.openai.com/auth": z
			.object({
				chatgpt_account_id: z.string().min(1).optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

export type OpenAIBrowserConnectOptions = {
	browser?: (url: string) => Promise<void>;
	openBrowser?: boolean;
	signal?: AbortSignal;
	onAuthorizationUrl?: (authorizationUrl: URL) => void;
	onStatus?: (status: ConnectionProgress) => void;
	timeoutMs?: number;
	deps?: Partial<{
		calculatePKCECodeChallenge: typeof calculatePKCECodeChallenge;
		generateRandomCodeVerifier: typeof generateRandomCodeVerifier;
		generateRandomState: typeof generateRandomState;
		open: typeof open;
		serve: typeof serve;
	}>;
};

export type OpenAIBrowserAcquireOptions = Omit<
	OpenAIBrowserConnectOptions,
	"backend" | "onStatus"
> & {
	onStatus?: (status: AcquisitionProgress) => void;
};

export const acquireOpenAIBrowserCredential = async (
	options: OpenAIBrowserAcquireOptions
): Promise<Extract<OpenAICredential, { kind: "oauth-session" }>> => {
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
		const token = await exchangeToken({
			code,
			signal: options.signal,
			verifier,
		});
		const credential = createOpenAICredential(token);
		return credential;
	} finally {
		callbackServer.stop();
	}
};

export const refreshOpenAIOAuthCredential = (
	credential: Extract<OpenAICredential, { kind: "oauth-session" }>,
	signal?: AbortSignal
): Promise<Extract<OpenAICredential, { kind: "oauth-session" }>> => {
	if (!isNearExpiry(credential.expiresAt)) {
		return Promise.resolve(credential);
	}
	return doRefresh(credential, signal);
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
	signal?: AbortSignal;
	verifier: string;
}): Promise<unknown> {
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
		signal: input.signal,
	});
	if (!response.ok) {
		throw new Error("OpenAI OAuth token exchange failed.");
	}
	return response.json();
}

async function doRefresh(
	credential: Extract<OpenAICredential, { kind: "oauth-session" }>,
	signal?: AbortSignal
): Promise<Extract<OpenAICredential, { kind: "oauth-session" }>> {
	try {
		const form = new URLSearchParams({
			client_id: OPENAI_CLIENT_ID,
			grant_type: "refresh_token",
			refresh_token: credential.refreshToken,
		});
		const response = await fetch(new URL(OPENAI_TOKEN_PATH, OPENAI_ISSUER), {
			body: form,
			method: "POST",
			signal,
		});
		if (!response.ok) {
			throw new Error("OpenAI OAuth refresh failed.");
		}
		const token = await response.json();
		const next = createOpenAICredential(
			token,
			credential.refreshToken,
			credential.accountId
		);
		return next;
	} catch {
		throw new Error("Reconnect OpenAI with /connect");
	}
}

const isNearExpiry = (expiresAt: string): boolean =>
	Date.parse(expiresAt) - Date.now() <= OPENAI_REFRESH_SKEW_MS;

function createOpenAICredential(
	tokenInput: unknown,
	previousRefreshToken?: string,
	previousAccountId?: string
): Extract<OpenAICredential, { kind: "oauth-session" }> {
	const tokenResult = tokenResponseSchema.safeParse(tokenInput);
	if (!tokenResult.success) {
		throw new Error("OpenAI OAuth server returned an invalid token response.");
	}
	const token = tokenResult.data;
	const extractedAccountId = extractAccountId(
		token.id_token ?? token.access_token
	);
	const accountId = extractedAccountId ?? previousAccountId;
	const refreshToken = token.refresh_token ?? previousRefreshToken;
	if (!accountId) {
		throw new Error("OpenAI OAuth credential missing account id.");
	}
	if (!refreshToken) {
		throw new Error("OpenAI OAuth credential missing refresh token.");
	}
	const now = new Date();
	const credential: Extract<OpenAICredential, { kind: "oauth-session" }> = {
		accessToken: token.access_token,
		accountId,
		expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
		kind: "oauth-session",
		refreshToken,
		updatedAt: now.toISOString(),
	};
	return credential;
}

function extractAccountId(jwt: string | undefined): string | undefined {
	if (!jwt) {
		return;
	}
	try {
		const payloadResult = jwtPayloadSchema.safeParse(
			JSON.parse(
				Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")
			)
		);
		if (!payloadResult.success) {
			return;
		}
		const payload = payloadResult.data;
		const direct = payload.chatgpt_account_id;
		if (typeof direct === "string") {
			return direct;
		}
		const nested = payload["https://api.openai.com/auth"];
		if (nested?.chatgpt_account_id) {
			return nested.chatgpt_account_id;
		}
		const organizations = payload.organizations;
		if (organizations?.[0]) {
			return organizations[0].id;
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
