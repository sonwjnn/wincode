import {
	auth,
	type OAuthClientInformationContext,
	type OAuthClientMetadata,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type StoredOAuthClientInformation,
	type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { PluginSecretStore } from "@wincode/coding-agent";
import { isPlainObject } from "@wincode/utils";

const secretPrefix = (serverName: string): string => `mcp.oauth.${serverName}`;
const activeIssuerKey = (serverName: string): string =>
	`${secretPrefix(serverName)}.active-issuer`;
const issuerKey = (serverName: string, issuer: string): string =>
	`${secretPrefix(serverName)}.${encodeURIComponent(issuer)}`;
const flowKey = (serverName: string, name: string): string =>
	`${secretPrefix(serverName)}.flow.${name}`;

const deleteIssuerCredential = async (
	secrets: PluginSecretStore,
	serverName: string,
	credential: "client" | "tokens" | "discovery"
): Promise<void> => {
	const issuer = await secrets.get(activeIssuerKey(serverName));
	if (issuer !== undefined) {
		await secrets.delete(`${issuerKey(serverName, issuer)}.${credential}`);
	}
};

const parseSecret = async <Value>(
	secrets: PluginSecretStore,
	key: string,
	isValue: (value: unknown) => value is Value
): Promise<Value | undefined> => {
	const stored = await secrets.get(key);
	if (stored === undefined) {
		return;
	}
	try {
		const value: unknown = JSON.parse(stored);
		return isValue(value) ? value : undefined;
	} catch {
		return;
	}
};

const hasAccessToken = (value: unknown): value is StoredOAuthTokens =>
	isPlainObject(value) &&
	typeof value.access_token === "string" &&
	typeof value.token_type === "string";

const hasClientInformation = (
	value: unknown
): value is StoredOAuthClientInformation =>
	isPlainObject(value) && typeof value.client_id === "string";

const hasDiscoveryState = (value: unknown): value is OAuthDiscoveryState =>
	isPlainObject(value) && typeof value.authorizationServerUrl === "string";

const oauthConfig = (value: unknown): Readonly<Record<string, unknown>> =>
	isPlainObject(value) ? value : {};

export type McpOAuthProviderInput = Readonly<{
	onAuthorizationUrl?: (url: URL) => void | Promise<void>;
	oauth?: unknown;
	redirectUrl?: string;
	secrets: PluginSecretStore;
	serverName: string;
}>;

export type McpOAuthClientProvider = OAuthClientProvider &
	Readonly<{ getCurrentState: () => string | undefined }>;

export const createMcpOAuthProvider = ({
	onAuthorizationUrl,
	oauth: oauthValue,
	redirectUrl,
	secrets,
	serverName,
}: McpOAuthProviderInput): McpOAuthClientProvider => {
	const oauth = oauthConfig(oauthValue);
	const configuredClientId =
		typeof oauth.clientId === "string" ? oauth.clientId : undefined;
	const configuredClientSecret =
		typeof oauth.clientSecret === "string" ? oauth.clientSecret : undefined;
	const metadata: OAuthClientMetadata = {
		client_name:
			typeof oauth.clientName === "string" ? oauth.clientName : "Wincode",
		redirect_uris: redirectUrl === undefined ? [] : [redirectUrl],
		...(configuredClientSecret === undefined
			? { token_endpoint_auth_method: "none" }
			: { token_endpoint_auth_method: "client_secret_post" }),
	};
	let currentState: string | undefined;
	return {
		get clientMetadata() {
			return metadata;
		},
		get redirectUrl() {
			return redirectUrl;
		},
		async clientInformation(context?: OAuthClientInformationContext) {
			const issuer =
				context?.issuer ?? (await secrets.get(activeIssuerKey(serverName)));
			if (issuer !== undefined) {
				const stored = await parseSecret(
					secrets,
					`${issuerKey(serverName, issuer)}.client`,
					hasClientInformation
				);
				if (stored !== undefined) {
					return stored;
				}
			}
			if (configuredClientId === undefined) {
				return;
			}
			return {
				client_id: configuredClientId,
				...(configuredClientSecret === undefined
					? {}
					: { client_secret: configuredClientSecret }),
			} as StoredOAuthClientInformation;
		},
		async saveClientInformation(information, context) {
			const issuer = context?.issuer ?? information.issuer;
			if (issuer === undefined) {
				throw new Error("OAuth client registration did not include an issuer.");
			}
			await secrets.set(
				`${issuerKey(serverName, issuer)}.client`,
				JSON.stringify(information)
			);
			await secrets.set(activeIssuerKey(serverName), issuer);
		},
		async tokens(context) {
			const issuer =
				context?.issuer ?? (await secrets.get(activeIssuerKey(serverName)));
			if (issuer === undefined) {
				return;
			}
			return await parseSecret(
				secrets,
				`${issuerKey(serverName, issuer)}.tokens`,
				hasAccessToken
			);
		},
		async saveTokens(tokens, context) {
			const issuer = context?.issuer ?? tokens.issuer;
			if (issuer === undefined) {
				throw new Error("OAuth tokens did not include an issuer.");
			}
			await secrets.set(
				`${issuerKey(serverName, issuer)}.tokens`,
				JSON.stringify(tokens)
			);
			await secrets.set(activeIssuerKey(serverName), issuer);
		},
		async state() {
			currentState ??= await secrets.get(flowKey(serverName, "state"));
			if (currentState === undefined) {
				currentState = crypto.randomUUID();
				await secrets.set(flowKey(serverName, "state"), currentState);
			}
			return currentState;
		},
		async saveCodeVerifier(verifier) {
			await secrets.set(flowKey(serverName, "verifier"), verifier);
		},
		async codeVerifier() {
			const verifier = await secrets.get(flowKey(serverName, "verifier"));
			if (verifier === undefined) {
				throw new Error("OAuth PKCE verifier is unavailable.");
			}
			return verifier;
		},
		async redirectToAuthorization(url) {
			await onAuthorizationUrl?.(url);
		},
		async saveDiscoveryState(state) {
			await secrets.set(
				`${issuerKey(serverName, state.authorizationServerUrl)}.discovery`,
				JSON.stringify(state)
			);
			await secrets.set(
				activeIssuerKey(serverName),
				state.authorizationServerUrl
			);
		},
		async discoveryState() {
			const issuer = await secrets.get(activeIssuerKey(serverName));
			if (issuer === undefined) {
				return;
			}
			return await parseSecret(
				secrets,
				`${issuerKey(serverName, issuer)}.discovery`,
				hasDiscoveryState
			);
		},
		async invalidateCredentials(scope) {
			if (scope === "all" || scope === "client") {
				await deleteIssuerCredential(secrets, serverName, "client");
			}
			if (scope === "all" || scope === "tokens") {
				await deleteIssuerCredential(secrets, serverName, "tokens");
			}
			if (scope === "all" || scope === "verifier") {
				await secrets.delete(flowKey(serverName, "verifier"));
				await secrets.delete(flowKey(serverName, "state"));
			}
			if (scope === "all" || scope === "discovery") {
				await deleteIssuerCredential(secrets, serverName, "discovery");
			}
			if (scope === "all") {
				await secrets.delete(activeIssuerKey(serverName));
			}
		},
		getCurrentState: () => currentState,
	};
};

export type McpOAuthLoginInput = Readonly<{
	openAuthorizationUrl: (url: URL) => void | Promise<void>;
	oauth?: unknown;
	readRedirectUrl?: (callback: Promise<URL>) => Promise<URL>;
	secrets: PluginSecretStore;
	serverName: string;
	serverUrl: string;
}>;

type OAuthCallback = Readonly<{
	promise: Promise<URL>;
	reject: (reason?: unknown) => void;
	resolve: (value: URL | PromiseLike<URL>) => void;
}>;

const createOAuthCallbackHandler =
	(callback: OAuthCallback, getState: () => string | undefined) =>
	(request: Request): Response => {
		const url = new URL(request.url);
		if (url.pathname !== "/oauth/callback") {
			return new Response("Not found", { status: 404 });
		}
		const state = url.searchParams.get("state");
		if (state === null || state !== getState()) {
			return new Response("Invalid OAuth state", { status: 400 });
		}
		if (url.searchParams.has("error")) {
			callback.reject(new Error("OAuth authorization was denied."));
			return new Response("Authorization was denied. Return to Wincode.", {
				status: 400,
			});
		}
		if (!url.searchParams.has("code")) {
			return new Response("Authorization code is missing", { status: 400 });
		}
		callback.resolve(url);
		return new Response("Authorization complete. You can return to Wincode.", {
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	};

const authorizationCodeFrom = (
	response: URL,
	expectedState: string | undefined
): string => {
	if (
		expectedState === undefined ||
		response.searchParams.get("state") !== expectedState
	) {
		throw new Error("OAuth authorization response state did not match.");
	}
	const code = response.searchParams.get("code");
	if (code === null || code.length === 0) {
		throw new Error("OAuth authorization response did not include a code.");
	}
	return code;
};

export const loginMcpServer = async ({
	openAuthorizationUrl,
	oauth,
	readRedirectUrl,
	secrets,
	serverName,
	serverUrl,
}: McpOAuthLoginInput): Promise<void> => {
	const callback = Promise.withResolvers<URL>();
	let getState: () => string | undefined = () => undefined;
	const server = Bun.serve({
		fetch: createOAuthCallbackHandler(callback, () => getState()),
		hostname: "127.0.0.1",
		port: 0,
	});
	const redirectUrl = `http://127.0.0.1:${server.port}/oauth/callback`;
	await secrets.delete(flowKey(serverName, "state"));
	await secrets.delete(flowKey(serverName, "verifier"));
	const provider = createMcpOAuthProvider({
		onAuthorizationUrl: openAuthorizationUrl,
		oauth,
		redirectUrl,
		secrets,
		serverName,
	});
	getState = () => provider.getCurrentState();
	try {
		const firstResult = await auth(provider, { serverUrl });
		if (firstResult === "AUTHORIZED") {
			return;
		}
		const response = await (readRedirectUrl?.(callback.promise) ??
			callback.promise);
		const code = authorizationCodeFrom(response, provider.getCurrentState());
		const result = await auth(provider, {
			authorizationCode: code,
			iss: response.searchParams.get("iss") ?? undefined,
			serverUrl,
		});
		if (result !== "AUTHORIZED") {
			throw new Error("OAuth authorization did not complete.");
		}
		await secrets.delete(flowKey(serverName, "state"));
		await secrets.delete(flowKey(serverName, "verifier"));
	} finally {
		server.stop(true);
	}
};

export const logoutMcpServer = async (
	secrets: PluginSecretStore,
	serverName: string
): Promise<void> => {
	const provider = createMcpOAuthProvider({ secrets, serverName });
	await provider.invalidateCredentials?.("all");
};
