import { describe, expect, mock, test } from "bun:test";

mock.module("@wincode/env/server", () => ({
	env: {
		BETTER_AUTH_URL: "https://auth.example.com/api/auth",
		DATABASE_URL: "postgres://example",
		WINCODE_API_KEY_PEPPER: "pepperpepperpepperpepperpepperpepper",
	},
}));

mock.module("@wincode/auth", () => ({
	auth: {
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
		}),
		schema: {
			apiKey: {
				expiresAt: {},
				revokedAt: {},
				secretHash: {},
				scopes: {},
				userId: {},
				lookupPrefix: {},
			},
		},
	},
	verifyAccessToken: mock(async () => null),
}));

const { parseApiKey, verifyBearerAuth } = await import("./credentials");

describe("api key parser", () => {
	test("accepts strict hosted format", () => {
		expect(parseApiKey("wck_live_abcd_012345")).toEqual({
			lookupPrefix: "abcd",
			secret: "012345",
		});
	});

	test("rejects malformed keys", () => {
		expect(parseApiKey("bad")).toBeNull();
	});

	test("verifies OAuth tokens against the auth route metadata", async () => {
		const { verifyAccessToken } = await import("@wincode/auth");
		await verifyBearerAuth("Bearer oauth-token");

		expect(verifyAccessToken).toHaveBeenCalledWith("oauth-token", {
			jwksUrl: "https://auth.example.com/api/auth/jwks",
			scopes: ["chat:write"],
			verifyOptions: {
				audience: "https://auth.example.com/api",
				issuer: "https://auth.example.com/api/auth",
			},
		});
	});
});
