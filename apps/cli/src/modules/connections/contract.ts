import type { ConnectionProviderId } from "@wincode/ai";
import { z } from "zod";

export type ConnectionProgress =
	| "starting"
	| "opening-browser"
	| "waiting-for-callback"
	| "exchanging-token"
	| "connected";

export type AcquisitionProgress = Exclude<
	ConnectionProgress,
	"starting" | "connected"
>;

const apiKeyCredentialSchema = z
	.object({
		kind: z.literal("api-key"),
		apiKey: z.string().min(1),
	})
	.strict();

const openaiOauthCredentialSchema = z
	.object({
		accessToken: z.string().min(1),
		accountId: z.string().min(1),
		expiresAt: z.string().datetime(),
		kind: z.literal("oauth-session"),
		refreshToken: z.string().min(1),
		updatedAt: z.string().datetime(),
	})
	.strict();

const wincodeOauthCredentialSchema = z
	.object({
		accessToken: z.string().min(1),
		clientId: z.string().min(1),
		kind: z.literal("oauth-session"),
		expiresAt: z.string().datetime(),
		resource: z.url(),
		issuer: z.url(),
		refreshToken: z.string().min(1),
		scope: z.string(),
		tokenType: z.literal("Bearer"),
		updatedAt: z.string().datetime(),
	})
	.strict();

export const credentialSchemas = {
	anthropic: apiKeyCredentialSchema,
	google: apiKeyCredentialSchema,
	openai: z.discriminatedUnion("kind", [
		apiKeyCredentialSchema,
		openaiOauthCredentialSchema,
	]),
	wincode: z.discriminatedUnion("kind", [
		apiKeyCredentialSchema,
		wincodeOauthCredentialSchema,
	]),
} as const;

export const connectionProviderDisplayNames: Record<
	ConnectionProviderId,
	string
> = {
	anthropic: "Anthropic",
	google: "Google",
	openai: "OpenAI",
	wincode: "Wincode",
};

export type ConnectionProviderSummary =
	| {
			connected: false;
			displayName: string;
			id: ConnectionProviderId;
			methods: readonly ProviderMethod[];
	  }
	| {
			connected: true;
			connectionMethod: ProviderMethod;
			displayName: string;
			id: ConnectionProviderId;
			methods: readonly ProviderMethod[];
	  };

export type ApiKeyCredential = z.infer<typeof apiKeyCredentialSchema>;
export type OpenAICredential = z.infer<(typeof credentialSchemas)["openai"]>;
export type WincodeCredential = z.infer<(typeof credentialSchemas)["wincode"]>;
export type AnthropicCredential = z.infer<
	(typeof credentialSchemas)["anthropic"]
>;

export type CredentialByProvider = {
	anthropic: AnthropicCredential;
	google: z.infer<(typeof credentialSchemas)["google"]>;
	openai: OpenAICredential;
	wincode: WincodeCredential;
};

export type Credential = CredentialByProvider[keyof CredentialByProvider];

export type AuthorizationByProvider = {
	anthropic: { kind: "api-key"; apiKey: string };
	google: { kind: "api-key"; apiKey: string };
	openai:
		| { kind: "api-key"; apiKey: string }
		| { kind: "oauth"; accessToken: string; accountId: string };
	wincode:
		| { kind: "api-key"; apiKey: string }
		| { kind: "bearer"; token: string };
};

export type ConnectionAuthorization =
	AuthorizationByProvider[ConnectionProviderId];

export type ConnectRequest =
	| {
			providerId: "anthropic";
			method: "api-key";
			apiKey: string;
			signal?: AbortSignal;
	  }
	| {
			providerId: "google";
			method: "api-key";
			apiKey: string;
			signal?: AbortSignal;
	  }
	| {
			providerId: "openai";
			method: "api-key";
			apiKey: string;
			signal?: AbortSignal;
	  }
	| {
			providerId: "openai";
			method: "browser";
			signal?: AbortSignal;
			onProgress?: (status: ConnectionProgress) => void;
			onAuthorizationUrl?: (authorizationUrl: URL) => void;
	  }
	| {
			providerId: "wincode";
			method: "api-key";
			apiKey: string;
			signal?: AbortSignal;
	  }
	| {
			providerId: "wincode";
			method: "browser";
			signal?: AbortSignal;
			onProgress?: (status: ConnectionProgress) => void;
			onAuthorizationUrl?: (authorizationUrl: URL) => void;
	  };

export type ProviderMethod = "api-key" | "browser";

export type BrowserCapableConnectionProviderId = Extract<
	ConnectionProviderId,
	"openai" | "wincode"
>;

export const isBrowserCapableProvider = (
	provider: Pick<ConnectionProviderSummary, "id" | "methods">
): provider is Pick<ConnectionProviderSummary, "methods"> & {
	id: BrowserCapableConnectionProviderId;
} => provider.methods.includes("browser");

export type ConnectRequestFor<P extends ConnectionProviderId> = Extract<
	ConnectRequest,
	{ providerId: P }
>;

export type ProviderAdapter<P extends ConnectionProviderId> = {
	connect(request: ConnectRequestFor<P>): Promise<CredentialByProvider[P]>;
	authorize(
		credential: CredentialByProvider[P],
		signal?: AbortSignal
	): Promise<{
		authorization: AuthorizationByProvider[P];
		replacementCredential?: CredentialByProvider[P];
	}>;
	methods: readonly ProviderMethod[];
	status(credential: CredentialByProvider[P] | null): ConnectionProviderSummary;
};

export type ProviderAdapterMap = {
	[providerId in ConnectionProviderId]: ProviderAdapter<providerId>;
};

export type Connections = {
	listProviders(): Promise<readonly ConnectionProviderSummary[]>;
	connect(request: ConnectRequest): Promise<void>;
	authorize(
		providerId: "anthropic",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["anthropic"]>;
	authorize(
		providerId: "google",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["google"]>;
	authorize(
		providerId: "openai",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["openai"]>;
	authorize(
		providerId: "wincode",
		signal?: AbortSignal
	): Promise<AuthorizationByProvider["wincode"]>;
	authorize(
		providerId: ConnectionProviderId,
		signal?: AbortSignal
	): Promise<ConnectionAuthorization>;
};
