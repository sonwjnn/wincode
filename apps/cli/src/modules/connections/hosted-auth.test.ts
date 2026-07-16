import { describe, expect, mock, test } from "bun:test";

mock.module("oauth4webapi", () => ({
	allowInsecureRequests: Symbol("allow"),
	discoveryRequest: mock(async () => new Response("{}")),
	processDiscoveryResponse: mock(async () => ({
		token_endpoint: "https://auth.example.com/token",
	})),
	processRefreshTokenResponse: mock(async () => ({
		access_token: "new",
		expires_in: 60,
		token_type: "Bearer",
	})),
	refreshTokenGrantRequest: mock(
		async () =>
			new Response(
				JSON.stringify({
					access_token: "new",
					expires_in: 60,
					token_type: "Bearer",
				}),
				{ status: 200 }
			)
	),
	None: () => undefined,
}));

describe("hosted auth primitives", () => {
	test("validation uses hono client and hides api key", async () => {
		const validate = mock(async () => new Response("nope", { status: 401 }));
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: { credentials: { validate: { $get: validate } } },
			}),
		}));
		const { validateWincodeApiKey } = await import("./hosted-auth");
		const signal = new AbortController().signal;
		await expect(validateWincodeApiKey("secret-key", signal)).rejects.toThrow(
			"Wincode API key validation failed."
		);
		expect(validate).toHaveBeenCalledWith(
			{
				header: { Authorization: "Bearer secret-key" },
			},
			{ init: { signal } }
		);
	});

	test("refresh uses canonical resource", async () => {
		const { refreshWincodeOAuthCredential } = await import("./hosted-auth");
		const credential = {
			accessToken: "old",
			clientId: "client",
			kind: "oauth-session" as const,
			expiresAt: new Date(Date.now() - 1000).toISOString(),
			issuer: "https://auth.example.com",
			refreshToken: "refresh",
			resource: "https://example.com/api",
			scope: "chat:write",
			tokenType: "Bearer" as const,
			updatedAt: new Date().toISOString(),
		};
		await expect(
			refreshWincodeOAuthCredential(credential)
		).resolves.toMatchObject({
			accessToken: "new",
		});
	});
});
