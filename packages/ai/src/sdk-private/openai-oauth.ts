import * as http from "node:http";
import {
	calculatePKCECodeChallenge,
	generateRandomCodeVerifier,
	generateRandomState,
} from "oauth4webapi";
import open from "open";
import { z } from "zod";
import {
	type OpenAICredential,
	openaiOauthCredentialSchema,
} from "../connections/credential-schemas.ts";

const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_ISSUER = "https://auth.openai.com";
const OPENAI_REDIRECT_URI = "http://localhost:1455/auth/callback";
const OPENAI_REFRESH_SKEW_MS = 5 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
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
			.array(z.object({ id: z.string().min(1) }).passthrough())
			.optional(),
		"https://api.openai.com/auth": z
			.object({ chatgpt_account_id: z.string().min(1).optional() })
			.passthrough()
			.optional(),
	})
	.passthrough();

export type OpenAIFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export type OpenAIOAuthCredential = Extract<
	OpenAICredential,
	{ kind: "oauth-session" }
>;

export class OpenAIOAuthRefreshError extends Error {
	readonly code: "authentication" | "provider" | "transport";

	constructor(
		code: "authentication" | "provider" | "transport",
		message: string,
		cause?: unknown
	) {
		super(message, { cause });
		this.name = "OpenAIOAuthRefreshError";
		this.code = code;
	}
}

export type OpenAIBrowserLoginOptions = Readonly<{
	browser?: (url: string) => Promise<void>;
	onAuthorizationUrl?: (authorizationUrl: URL) => void;
	onStatus?: (
		status: "opening-browser" | "waiting-for-callback" | "exchanging-token"
	) => void;
	openBrowser?: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}>;

export const acquireOpenAIOAuthCredential = async (
	options: OpenAIBrowserLoginOptions = {},
	fetchImpl: OpenAIFetch = globalThis.fetch.bind(globalThis)
): Promise<OpenAIOAuthCredential> => {
	const verifier = generateRandomCodeVerifier();
	const challenge = await calculatePKCECodeChallenge(verifier);
	const state = generateRandomState();
	const callbackServer = await startCallbackServer();
	try {
		const authorizationUrl = createAuthorizationUrl(challenge, state);
		options.onAuthorizationUrl?.(authorizationUrl);
		if (options.openBrowser ?? true) {
			options.onStatus?.("opening-browser");
			await (options.browser ?? open)(authorizationUrl.href);
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
		const response = await fetchImpl(new URL("/oauth/token", OPENAI_ISSUER), {
			body: new URLSearchParams({
				client_id: OPENAI_CLIENT_ID,
				code,
				code_verifier: verifier,
				grant_type: "authorization_code",
				redirect_uri: OPENAI_REDIRECT_URI,
			}),
			signal: options.signal,
			method: "POST",
		});
		if (!response.ok) {
			throw new Error("OpenAI OAuth token exchange failed.");
		}
		return createCredential(await response.json());
	} finally {
		callbackServer.stop();
	}
};

export const refreshOpenAIOAuthCredential = async (
	credential: OpenAIOAuthCredential,
	fetchImpl: OpenAIFetch,
	signal?: AbortSignal
): Promise<OpenAIOAuthCredential> => {
	if (Date.parse(credential.expiresAt) - Date.now() > OPENAI_REFRESH_SKEW_MS) {
		return credential;
	}
	let response: Response;
	try {
		response = await fetchImpl(new URL("/oauth/token", OPENAI_ISSUER), {
			body: new URLSearchParams({
				client_id: OPENAI_CLIENT_ID,
				grant_type: "refresh_token",
				refresh_token: credential.refreshToken,
			}),
			signal,
			method: "POST",
		});
	} catch (error) {
		if (signal?.aborted) {
			throw signal.reason ?? error;
		}
		throw new OpenAIOAuthRefreshError(
			"transport",
			"OpenAI OAuth token refresh request failed.",
			error
		);
	}
	if (!response.ok) {
		const code =
			response.status === 400 ||
			response.status === 401 ||
			response.status === 403
				? "authentication"
				: "provider";
		throw new OpenAIOAuthRefreshError(
			code,
			code === "authentication"
				? "OpenAI OAuth credentials expired; sign in again."
				: `OpenAI OAuth refresh failed (${response.status}).`
		);
	}
	try {
		return createCredential(
			await response.json(),
			credential.refreshToken,
			credential.accountId
		);
	} catch (error) {
		throw new OpenAIOAuthRefreshError(
			"provider",
			"OpenAI returned an invalid OAuth refresh response.",
			error
		);
	}
};

const createAuthorizationUrl = (challenge: string, state: string): URL => {
	const url = new URL("/oauth/authorize", OPENAI_ISSUER);
	url.searchParams.set("client_id", OPENAI_CLIENT_ID);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("redirect_uri", OPENAI_REDIRECT_URI);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("scope", "openid profile email offline_access");
	url.searchParams.set("state", state);
	url.searchParams.set("codex_cli_simplified_flow", "true");
	url.searchParams.set("id_token_add_organizations", "true");
	url.searchParams.set("originator", "wincode");
	return url;
};

const createCredential = (
	value: unknown,
	previousRefreshToken?: string,
	previousAccountId?: string
): OpenAIOAuthCredential => {
	const tokenResult = tokenResponseSchema.safeParse(value);
	if (!tokenResult.success) {
		throw new Error("OpenAI OAuth server returned an invalid token response.");
	}
	const token = tokenResult.data;
	const accountId =
		extractAccountId(token.id_token ?? token.access_token) ?? previousAccountId;
	const refreshToken = token.refresh_token ?? previousRefreshToken;
	if (!accountId) {
		throw new Error("OpenAI OAuth credential missing account id.");
	}
	if (!refreshToken) {
		throw new Error("OpenAI OAuth credential missing refresh token.");
	}
	const now = new Date();
	return openaiOauthCredentialSchema.parse({
		accessToken: token.access_token,
		accountId,
		expiresAt: new Date(now.getTime() + token.expires_in * 1000).toISOString(),
		kind: "oauth-session",
		refreshToken,
		updatedAt: now.toISOString(),
	});
};

const extractAccountId = (jwt: string | undefined): string | undefined => {
	if (!jwt) {
		return;
	}
	try {
		const payload = jwtPayloadSchema.parse(
			JSON.parse(
				Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")
			)
		);
		return (
			payload.chatgpt_account_id ??
			payload["https://api.openai.com/auth"]?.chatgpt_account_id ??
			payload.organizations?.[0]?.id
		);
	} catch {
		return;
	}
};

type CallbackServer = Readonly<{
	stop: () => void;
	waitForCallback: (timeoutMs: number, signal?: AbortSignal) => Promise<URL>;
}>;

const startCallbackServer = async (): Promise<CallbackServer> => {
	const callbackUrl = new URL(OPENAI_REDIRECT_URI);
	const callback = Promise.withResolvers<URL>();
	let received = false;
	const server = http.createServer((request, response) => {
		const requestUrl = new URL(
			request.url ?? "/",
			`http://${request.headers.host ?? callbackUrl.host}`
		);
		if (
			received ||
			requestUrl.origin !== callbackUrl.origin ||
			requestUrl.pathname !== callbackUrl.pathname
		) {
			response.writeHead(404);
			response.end("Not found");
			return;
		}
		received = true;
		callback.resolve(requestUrl);
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(
			"<title>OpenAI</title><p>Connected. You can close this tab.</p>"
		);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", listening.reject);
	server.listen(Number(callbackUrl.port), callbackUrl.hostname, () => {
		server.off("error", listening.reject);
		listening.resolve();
	});
	try {
		await listening.promise;
	} catch (error) {
		server.close();
		throw error;
	}
	let stopped = false;
	const stop = (): void => {
		if (!stopped) {
			stopped = true;
			server.close();
		}
	};
	return {
		stop,
		waitForCallback: (timeoutMs, signal) => {
			const result = Promise.withResolvers<URL>();
			let settled = false;
			const cleanup = (): void => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", onAbort);
			};
			const finish = (callbackResult: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				cleanup();
				callbackResult();
			};
			const onAbort = (): void => {
				finish(() => {
					stop();
					result.reject(new Error("Browser sign-in aborted."));
				});
			};
			const timeout = setTimeout(() => {
				finish(() => result.reject(new Error("Browser sign-in timed out.")));
			}, timeoutMs).unref();
			if (signal?.aborted) {
				onAbort();
				return result.promise;
			}
			signal?.addEventListener("abort", onAbort, { once: true });
			callback.promise.then((url) => finish(() => result.resolve(url)));
			return result.promise;
		},
	};
};
