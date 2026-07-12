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

const { refreshTokenGrantRequest } = await import("oauth4webapi");

describe("hosted auth", () => {
	test("api key bearer", async () => {
		const { getHostedBearer } = await import("./hosted-auth");
		await expect(
			getHostedBearer({
				async load() {
					return { kind: "api-key", apiKey: "key" };
				},
			} as any)
		).resolves.toBe("key");
	});

	test("validation uses hono client and hides api key", async () => {
		const validate = mock(async () => new Response("nope", { status: 401 }));
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: { credentials: { validate: { $get: validate } } },
			}),
		}));
		const { validateWincodeApiKey } = await import("./hosted-auth");
		await expect(validateWincodeApiKey("secret-key")).rejects.toThrow(
			"Wincode API key validation failed."
		);
		expect(validate).toHaveBeenCalledWith({
			header: { Authorization: "Bearer secret-key" },
		});
	});

	test("refresh uses canonical resource", async () => {
		const { getHostedBearer } = await import("./hosted-auth");
		const refreshGrant = refreshTokenGrantRequest as unknown as {
			mock: { calls: unknown[][] };
		};
		await expect(
			getHostedBearer({
				async load() {
					return {
						kind: "oauth-session",
						accessToken: "old",
						clientId: "client",
						expiresAt: new Date(Date.now() - 1000).toISOString(),
						issuer: "https://auth.example.com",
						refreshToken: "refresh",
						resource: "https://example.com/api",
						scope: "chat:write",
						tokenType: "Bearer",
						updatedAt: new Date().toISOString(),
					};
				},
				async replaceValidated() {
					return;
				},
			} as any)
		).resolves.toBe("new");
		expect(refreshGrant.mock.calls[0]?.[1]).toEqual({ client_id: "client" });
		expect(refreshGrant.mock.calls[0]?.[3]).toBe("refresh");
		expect(refreshGrant.mock.calls[0]?.[4]).toEqual({
			additionalParameters: { resource: "https://example.com/api" },
		});
	});
});
