import type { ValidationFetch } from "./api-key-validation";
import {
	validateAnthropicKey,
	validateGoogleKey,
	validateOpenAIKey,
} from "./api-key-validation";
import {
	acquireWincodeBrowserCredential,
	getWincodeBrowserConfig,
} from "./connect-wincode-browser";
import type {
	ApiKeyCredential,
	AuthorizationByProvider,
	ConnectionProviderSummary,
	ConnectRequestFor,
	CredentialByProvider,
	ProviderAdapterMap,
	ProviderMethod,
} from "./contract";
import { connectionProviderDisplayNames } from "./contract";
import {
	refreshWincodeOAuthCredential,
	validateWincodeApiKey,
} from "./hosted-auth";
import {
	acquireOpenAIBrowserCredential,
	refreshOpenAIOAuthCredential,
} from "./openai-browser-oauth";

export type ProviderAdapterDependencies = {
	validateAnthropicApiKey?: (
		apiKey: string,
		signal?: AbortSignal
	) => Promise<void>;
	validateGoogleApiKey?: (
		apiKey: string,
		signal?: AbortSignal
	) => Promise<void>;
	validateOpenAIApiKey?: (
		apiKey: string,
		signal?: AbortSignal
	) => Promise<void>;
	validateWincodeApiKey?: (
		apiKey: string,
		signal?: AbortSignal
	) => Promise<void>;
	acquireOpenAIBrowserCredential?: typeof acquireOpenAIBrowserCredential;
	acquireWincodeBrowserCredential?: typeof acquireWincodeBrowserCredential;
	refreshOpenAIOAuthCredential?: typeof refreshOpenAIOAuthCredential;
	refreshWincodeOAuthCredential?: typeof refreshWincodeOAuthCredential;
};

const methodsByProvider: Record<
	keyof CredentialByProvider,
	readonly ProviderMethod[]
> = {
	anthropic: ["api-key"],
	google: ["api-key"],
	openai: ["api-key", "browser"],
	wincode: ["api-key", "browser"],
};

export const createProviderAdapters = (
	deps: ProviderAdapterDependencies
): ProviderAdapterMap => ({
	anthropic: createApiKeyAdapter(
		"anthropic",
		deps.validateAnthropicApiKey ?? wrapApiKeyValidator(validateAnthropicKey)
	),
	google: createApiKeyAdapter(
		"google",
		deps.validateGoogleApiKey ?? wrapApiKeyValidator(validateGoogleKey)
	),
	openai: {
		connect: async (request) =>
			request.method === "browser"
				? (
						deps.acquireOpenAIBrowserCredential ??
						acquireOpenAIBrowserCredential
					)({
						...request,
						onStatus: request.onProgress,
						openBrowser: false,
						signal: request.signal,
					})
				: validateAndBuildApiKey(
						request,
						deps.validateOpenAIApiKey ?? wrapApiKeyValidator(validateOpenAIKey)
					),
		authorize: async (credential, signal) =>
			credential.kind === "oauth-session"
				? authorizeOpenAiOauth(
						credential,
						deps.refreshOpenAIOAuthCredential ?? refreshOpenAIOAuthCredential,
						signal
					)
				: {
						authorization: {
							kind: "api-key" as const,
							apiKey: credential.apiKey,
						},
					},
		methods: methodsByProvider.openai,
		status: (credential) => summarize("openai", credential),
	},
	wincode: {
		connect: async (request) => {
			if (request.method === "browser") {
				return buildWincodeBrowserCredential(
					request,
					deps.acquireWincodeBrowserCredential ??
						acquireWincodeBrowserCredential
				);
			}
			return validateAndBuildApiKey(
				request,
				deps.validateWincodeApiKey ?? validateWincodeApiKey
			);
		},
		authorize: async (credential, signal) => {
			if (credential.kind === "oauth-session") {
				const next = await (
					deps.refreshWincodeOAuthCredential ?? refreshWincodeOAuthCredential
				)(credential, signal);
				return {
					authorization: { kind: "bearer" as const, token: next.accessToken },
					replacementCredential: next === credential ? undefined : next,
				};
			}
			return {
				authorization: { kind: "api-key" as const, apiKey: credential.apiKey },
			};
		},
		methods: methodsByProvider.wincode,
		status: (credential) => summarize("wincode", credential),
	},
});

const createApiKeyAdapter = <P extends "anthropic" | "google">(
	providerId: P,
	validator?: (apiKey: string, signal?: AbortSignal) => Promise<void>
) => ({
	connect: async (request: ConnectRequestFor<P>) =>
		validateAndBuildApiKey(request, validator),
	authorize: async (credential: CredentialByProvider[P]) => ({
		authorization: { kind: "api-key" as const, apiKey: credential.apiKey },
	}),
	methods: methodsByProvider[providerId],
	status: (credential: CredentialByProvider[P] | null) =>
		summarize(providerId, credential),
});

const validateAndBuildApiKey = async (
	request: Extract<
		ConnectRequestFor<"anthropic" | "google" | "openai" | "wincode">,
		{ method: "api-key" }
	>,
	validator?: (apiKey: string, signal?: AbortSignal) => Promise<void>
): Promise<ApiKeyCredential> => {
	await validator?.(request.apiKey, request.signal);
	return { kind: "api-key", apiKey: request.apiKey };
};

const wrapApiKeyValidator =
	(
		validator: (
			credential: ApiKeyCredential,
			fetchImpl?: ValidationFetch
		) => Promise<void>
	): ((apiKey: string, signal?: AbortSignal) => Promise<void>) =>
	async (apiKey, signal) => {
		await validator({ kind: "api-key", apiKey }, (input, init) =>
			fetch(input, {
				...init,
				signal: init?.signal ?? signal,
			})
		);
	};

const authorizeOpenAiOauth = async (
	credential: Extract<
		CredentialByProvider["openai"],
		{ kind: "oauth-session" }
	>,
	refresh: typeof refreshOpenAIOAuthCredential,
	signal?: AbortSignal
): Promise<{
	authorization: AuthorizationByProvider["openai"];
	replacementCredential?: CredentialByProvider["openai"];
}> => {
	const next = await refresh(credential, signal);
	if (!next.accountId) {
		throw new Error("OpenAI OAuth credential missing account id.");
	}
	return {
		authorization: {
			kind: "oauth" as const,
			accessToken: next.accessToken,
			accountId: next.accountId,
		},
		replacementCredential: next === credential ? undefined : next,
	};
};

const buildWincodeBrowserCredential = async (
	request: Extract<ConnectRequestFor<"wincode">, { method: "browser" }>,
	acquire: typeof acquireWincodeBrowserCredential
): Promise<CredentialByProvider["wincode"]> => {
	const config = getWincodeBrowserConfig();
	const credential = await acquire({
		...request,
		onStatus: request.onProgress,
		openBrowser: false,
		issuer: config.issuer,
		clientId: config.clientId,
		redirectUri: config.redirectUri,
		resource: config.resource,
	});
	return credential;
};

const summarize = <P extends keyof CredentialByProvider>(
	providerId: P,
	credential: CredentialByProvider[P] | null
): ConnectionProviderSummary =>
	credential === null
		? {
				connected: false,
				displayName: connectionProviderDisplayNames[providerId],
				id: providerId,
				methods: methodsByProvider[providerId],
			}
		: {
				connected: true,
				connectionMethod: credential.kind === "api-key" ? "api-key" : "browser",
				displayName: connectionProviderDisplayNames[providerId],
				id: providerId,
				methods: methodsByProvider[providerId],
			};
