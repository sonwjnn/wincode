import { expect, test } from "bun:test";
import type {
	OAuthClientInformationContext,
	OAuthClientProvider,
	StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import type { PluginSecretStore } from "@wincode/coding-agent";
import { createMcpOAuthProvider, logoutMcpServer } from "../src/oauth";

const createSecretStore = (): Readonly<{
	secrets: PluginSecretStore;
	values: Map<string, string>;
}> => {
	const values = new Map<string, string>();
	return {
		secrets: {
			delete: async (key) => {
				values.delete(key);
			},
			get: async (key) => values.get(key),
			set: async (key, value) => {
				values.set(key, value);
			},
		},
		values,
	};
};

const issuer = "https://auth.example.test";
const context: OAuthClientInformationContext = { issuer };

const tokens = {
	access_token: "access-token",
	expires_in: 3600,
	issuer,
	refresh_token: "refresh-token",
	token_type: "Bearer",
} satisfies StoredOAuthTokens;

test("MCP OAuth credentials are isolated by server and persisted through Plugin secrets", async () => {
	const { secrets, values } = createSecretStore();
	const provider = createMcpOAuthProvider({
		oauth: { clientId: "configured-client" },
		redirectUrl: "http://127.0.0.1:45831/oauth/callback",
		secrets,
		serverName: "docs",
	});
	const state = await provider.state?.();
	if (state === undefined) {
		throw new Error("Expected an OAuth state value.");
	}
	await provider.saveCodeVerifier("pkce-verifier");
	await provider.saveTokens(tokens, context);

	expect(provider.clientMetadata.redirect_uris).toEqual([
		"http://127.0.0.1:45831/oauth/callback",
	]);
	expect(await provider.tokens(context)).toEqual(tokens);
	expect(await provider.codeVerifier()).toBe("pkce-verifier");
	expect(values.get("mcp.oauth.docs.flow.state")).toBe(state);
	await expect(
		createMcpOAuthProvider({ secrets, serverName: "other" }).tokens(context)
	).resolves.toBeUndefined();

	await logoutMcpServer(secrets, "docs");
	expect(await provider.tokens(context)).toBeUndefined();
	expect(values.has("mcp.oauth.docs.active-issuer")).toBe(false);
});

test("MCP OAuth providers supply redirect metadata and keep client IDs user scoped", async () => {
	const { secrets } = createSecretStore();
	const provider: OAuthClientProvider = createMcpOAuthProvider({
		oauth: { clientId: "saved-client-id", clientSecret: "saved-client-secret" },
		redirectUrl: "http://127.0.0.1:45832/oauth/callback",
		secrets,
		serverName: "calendar",
	});

	expect(provider.clientMetadata).toMatchObject({
		client_name: "Wincode",
		redirect_uris: ["http://127.0.0.1:45832/oauth/callback"],
		token_endpoint_auth_method: "client_secret_post",
	});
	await expect(provider.clientInformation(context)).resolves.toMatchObject({
		client_id: "saved-client-id",
		client_secret: "saved-client-secret",
	});
});
