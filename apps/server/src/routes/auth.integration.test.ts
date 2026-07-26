import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const handler = mock((request: Request) =>
	Promise.resolve(new Response(new URL(request.url).pathname))
);

mock.module("@wincode/auth", () => ({
	auth: {
		api: {
			getOAuthServerConfig: () =>
				Promise.resolve({ issuer: "http://localhost" }),
			getOpenIdConfig: () => Promise.resolve({ issuer: "http://localhost" }),
		},
		handler,
	},
}));

const { authRoutes, authWellKnownRoutes } = await import("./auth");

describe("auth routes", () => {
	test("forwards OAuth routes under the Better Auth base path", async () => {
		const response = await authRoutes.request("/oauth2/authorize");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("/oauth2/authorize");
	});

	test("rewrites OAuth discovery routes from the issuer root", async () => {
		const app = new Hono().route("/.well-known", authWellKnownRoutes);
		const response = await app.request(
			"/.well-known/oauth-authorization-server/api/auth"
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ issuer: "http://localhost" });
	});
});
