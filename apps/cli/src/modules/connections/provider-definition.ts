import type { ConnectionProviderId } from "@wincode/ai";
import type { ZodType, z } from "zod";
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
import {
	type ApiKeyCredential,
	anthropicCredentialSchema,
	type ConnectionProgress,
	googleCredentialSchema,
	openAICredentialSchema,
	wincodeCredentialSchema,
} from "./credential-schemas";
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
export type ProviderMethod = "api-key" | "browser";
export type Request<
	P extends ConnectionProviderId,
	M extends readonly ProviderMethod[],
> = {
	[MMethod in M[number]]: MMethod extends "api-key"
		? { providerId: P; method: MMethod; apiKey: string; signal?: AbortSignal }
		: {
				providerId: P;
				method: MMethod;
				signal?: AbortSignal;
				onProgress?: (status: ConnectionProgress) => void;
				onAuthorizationUrl?: (url: URL) => void;
			};
}[M[number]];
type Authorization =
	| { kind: "api-key"; apiKey: string }
	| { kind: "oauth"; accessToken: string; accountId: string }
	| { kind: "bearer"; token: string };
type OpenAIAuthorization = Extract<
	Authorization,
	{ kind: "api-key" | "oauth" }
>;
type WincodeAuthorization = Extract<
	Authorization,
	{ kind: "api-key" | "bearer" }
>;
type OpenAICredential = z.output<typeof openAICredentialSchema>;
type WincodeCredential = z.output<typeof wincodeCredentialSchema>;
export type ProviderDefinition<
	P extends ConnectionProviderId,
	Schema extends ZodType,
	M extends readonly ProviderMethod[] = readonly ProviderMethod[],
	A extends Authorization = Authorization,
> = {
	id: P;
	displayName: string;
	methods: M;
	credentialSchema: Schema;
	connect(request: Request<P, M>): Promise<z.output<Schema>>;
	authorize(
		credential: z.output<Schema>,
		signal?: AbortSignal
	): Promise<{ authorization: A; replacementCredential?: z.output<Schema> }>;
	status(credential: z.output<Schema> | null): ProviderSummary;
};
export const defineProvider = <
	const P extends ConnectionProviderId,
	Schema extends ZodType,
	const M extends readonly ProviderMethod[],
	D extends ProviderDefinition<P, Schema, M, Authorization>,
>(
	definition: D & ProviderDefinition<P, Schema, M, Authorization>
): D => definition;
export type ProviderSummary =
	| {
			connected: false;
			displayName: string;
			id: ConnectionProviderId;
			methods: readonly ("api-key" | "browser")[];
	  }
	| {
			connected: true;
			connectionMethod: "api-key" | "browser";
			displayName: string;
			id: ConnectionProviderId;
			methods: readonly ("api-key" | "browser")[];
	  };

const names = {
	anthropic: "Anthropic",
	google: "Google",
	openai: "OpenAI",
	wincode: "Wincode",
} as const;
const methods = {
	anthropic: ["api-key"],
	google: ["api-key"],
	openai: ["api-key", "browser"],
	wincode: ["api-key", "browser"],
} as const;
const summary = <P extends ConnectionProviderId, C extends { kind: string }>(
	id: P,
	credential: C | null
): ProviderSummary =>
	credential
		? {
				connected: true,
				connectionMethod: credential.kind === "api-key" ? "api-key" : "browser",
				displayName: names[id],
				id,
				methods: methods[id],
			}
		: { connected: false, displayName: names[id], id, methods: methods[id] };
const wrap =
	(
		validator: (
			credential: ApiKeyCredential,
			fetchImpl?: ValidationFetch
		) => Promise<void>
	) =>
	async (apiKey: string, signal?: AbortSignal) =>
		validator({ kind: "api-key", apiKey }, (input, init) =>
			fetch(input, { ...init, signal: init?.signal ?? signal })
		);
const apiKey = async (
	request: { apiKey: string; signal?: AbortSignal },
	validator?: (key: string, signal?: AbortSignal) => Promise<void>
): Promise<ApiKeyCredential> => {
	await validator?.(request.apiKey, request.signal);
	return { kind: "api-key", apiKey: request.apiKey };
};

export const createAnthropicProviderDefinition = (
	deps: ProviderAdapterDependencies
) =>
	defineProvider({
		id: "anthropic",
		displayName: names.anthropic,
		methods: methods.anthropic,
		credentialSchema: anthropicCredentialSchema,
		connect: (request) =>
			apiKey(
				request,
				deps.validateAnthropicApiKey ?? wrap(validateAnthropicKey)
			),
		authorize: async (credential) => ({
			authorization: { kind: "api-key", apiKey: credential.apiKey },
		}),
		status: (credential) => summary("anthropic", credential),
	});
export const createGoogleProviderDefinition = (
	deps: ProviderAdapterDependencies
) =>
	defineProvider({
		id: "google",
		displayName: names.google,
		methods: methods.google,
		credentialSchema: googleCredentialSchema,
		connect: (request) =>
			apiKey(request, deps.validateGoogleApiKey ?? wrap(validateGoogleKey)),
		authorize: async (credential) => ({
			authorization: { kind: "api-key", apiKey: credential.apiKey },
		}),
		status: (credential) => summary("google", credential),
	});
export const createOpenAIProviderDefinition = (
	deps: ProviderAdapterDependencies
) =>
	defineProvider({
		id: "openai",
		displayName: names.openai,
		methods: methods.openai,
		credentialSchema: openAICredentialSchema,
		connect: async (request) =>
			request.method === "browser"
				? (
						deps.acquireOpenAIBrowserCredential ??
						acquireOpenAIBrowserCredential
					)({ ...request, onStatus: request.onProgress, openBrowser: false })
				: apiKey(request, deps.validateOpenAIApiKey ?? wrap(validateOpenAIKey)),
		authorize: async (
			credential,
			signal?: AbortSignal
		): Promise<{
			authorization: OpenAIAuthorization;
			replacementCredential?: OpenAICredential;
		}> => {
			if (credential.kind === "api-key") {
				return {
					authorization: { kind: "api-key", apiKey: credential.apiKey },
				};
			}
			const next = await (
				deps.refreshOpenAIOAuthCredential ?? refreshOpenAIOAuthCredential
			)(credential, signal);
			if (!next.accountId) {
				throw new Error("OpenAI OAuth credential missing account id.");
			}
			return {
				authorization: {
					kind: "oauth",
					accessToken: next.accessToken,
					accountId: next.accountId,
				},
				replacementCredential: next === credential ? undefined : next,
			};
		},
		status: (credential) => summary("openai", credential),
	});
export const createWincodeProviderDefinition = (
	deps: ProviderAdapterDependencies
) =>
	defineProvider({
		id: "wincode",
		displayName: names.wincode,
		methods: methods.wincode,
		credentialSchema: wincodeCredentialSchema,
		connect: async (request) => {
			if (request.method === "browser") {
				const config = getWincodeBrowserConfig();
				return (
					deps.acquireWincodeBrowserCredential ??
					acquireWincodeBrowserCredential
				)({
					...request,
					onStatus: request.onProgress,
					openBrowser: false,
					issuer: config.issuer,
					clientId: config.clientId,
					redirectUri: config.redirectUri,
					resource: config.resource,
				});
			}
			return apiKey(
				request,
				deps.validateWincodeApiKey ?? validateWincodeApiKey
			);
		},
		authorize: async (
			credential,
			signal?: AbortSignal
		): Promise<{
			authorization: WincodeAuthorization;
			replacementCredential?: WincodeCredential;
		}> => {
			if (credential.kind === "api-key") {
				return {
					authorization: { kind: "api-key", apiKey: credential.apiKey },
				};
			}
			const next = await (
				deps.refreshWincodeOAuthCredential ?? refreshWincodeOAuthCredential
			)(credential, signal);
			return {
				authorization: { kind: "bearer", token: next.accessToken },
				replacementCredential: next === credential ? undefined : next,
			};
		},
		status: (credential) => summary("wincode", credential),
	});
