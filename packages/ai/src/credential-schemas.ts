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

export const apiKeyCredentialSchema = z
	.object({ kind: z.literal("api-key"), apiKey: z.string().min(1) })
	.strict();
export const openaiOauthCredentialSchema = z
	.object({
		accessToken: z.string().min(1),
		accountId: z.string().min(1),
		expiresAt: z.string().datetime(),
		kind: z.literal("oauth-session"),
		refreshToken: z.string().min(1),
		updatedAt: z.string().datetime(),
	})
	.strict();

export const openAICredentialSchema = z.discriminatedUnion("kind", [
	apiKeyCredentialSchema,
	openaiOauthCredentialSchema,
]);

export type ApiKeyCredential = z.infer<typeof apiKeyCredentialSchema>;
export type OpenAICredential = z.infer<typeof openAICredentialSchema>;
