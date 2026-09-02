import type { ConnectionProviderId } from "@wincode/ai";
import type { ZodType, z } from "zod";
import type { ValidationFetch } from "./api-key-validation";
import {
	validateAnthropicKey,
	validateGoogleKey,
	validateOpenAIKey,
	validateOpenCodeGoKey,
} from "./api-key-validation";
import {
	type ApiKeyCredential,
	apiKeyCredentialSchema,
	type ConnectionProgress,
	type OpenAICredential,
	openAICredentialSchema,
} from "./credential-schemas";
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
	validateOpenCodeGoApiKey?: (
		apiKey: string,
		signal?: AbortSignal
	) => Promise<void>;
	validateOpenAIApiKey?: (
		apiKey: string,
		signal?: AbortSignal
	) => Promise<void>;
	acquireOpenAIBrowserCredential?: typeof acquireOpenAIBrowserCredential;
	refreshOpenAIOAuthCredential?: typeof refreshOpenAIOAuthCredential;
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
	"opencode-go": "OpenCode Go",
	openai: "OpenAI",
} as const;
const methods = {
	anthropic: ["api-key"],
	google: ["api-key"],
	"opencode-go": ["api-key"],
	openai: ["api-key", "browser"],
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
		credentialSchema: apiKeyCredentialSchema,
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
		credentialSchema: apiKeyCredentialSchema,
		connect: (request) =>
			apiKey(request, deps.validateGoogleApiKey ?? wrap(validateGoogleKey)),
		authorize: async (credential) => ({
			authorization: { kind: "api-key", apiKey: credential.apiKey },
		}),
		status: (credential) => summary("google", credential),
	});
export const createOpenCodeGoProviderDefinition = (
	deps: ProviderAdapterDependencies
) =>
	defineProvider({
		id: "opencode-go",
		displayName: names["opencode-go"],
		methods: methods["opencode-go"],
		credentialSchema: apiKeyCredentialSchema,
		connect: (request) =>
			apiKey(
				request,
				deps.validateOpenCodeGoApiKey ?? wrap(validateOpenCodeGoKey)
			),
		authorize: async (credential) => ({
			authorization: { kind: "api-key", apiKey: credential.apiKey },
		}),
		status: (credential) => summary("opencode-go", credential),
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
