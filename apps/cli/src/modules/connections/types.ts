import { z } from "zod";

const providerIdSchema = z.enum(["wincode", "openai", "anthropic"]);

const apiKeySchema = z
	.object({
		kind: z.literal("api-key"),
		apiKey: z.string().min(1),
	})
	.strict();

const openaiOauthSchema = z
	.object({
		accessToken: z.string().min(1),
		accountId: z.string().min(1).optional(),
		expiresAt: z.string().datetime(),
		kind: z.literal("oauth-session"),
		refreshToken: z.string().min(1),
		updatedAt: z.string().datetime(),
	})
	.strict();

const wincodeOauthSchema = z
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
	anthropic: apiKeySchema,
	openai: z.discriminatedUnion("kind", [apiKeySchema, openaiOauthSchema]),
	wincode: z.discriminatedUnion("kind", [apiKeySchema, wincodeOauthSchema]),
} as const;

export type ProviderId = z.infer<typeof providerIdSchema>;
export type WincodeCredential = z.infer<(typeof credentialSchemas)["wincode"]>;
export type OpenAICredential = z.infer<(typeof credentialSchemas)["openai"]>;
export type AnthropicCredential = z.infer<
	(typeof credentialSchemas)["anthropic"]
>;

export type CredentialByProvider = {
	anthropic: AnthropicCredential;
	openai: OpenAICredential;
	wincode: WincodeCredential;
};

export type Credential = CredentialByProvider[ProviderId];

export type ConnectionStatus = {
	providerId: ProviderId;
	connected: boolean;
	kind?: "api-key" | "oauth-session";
};

export type LegacyWincodeSession = Omit<
	Extract<WincodeCredential, { kind: "oauth-session" }>,
	"kind"
>;

export const providerIds = providerIdSchema.options;
export const providerIdParser = providerIdSchema;
