import { describe, expect, mock, test } from "bun:test";

const verifyBearerAuth = mock(async () => ({
	type: "oauth",
	userId: "user-1",
	scopes: ["chat:write"],
}));

mock.module("../auth/credentials", () => ({
	requireScope: () => true,
	verifyBearerAuth,
}));

const { credentialsRoutes } = await import("./credentials");

describe("GET /api/credentials/validate", () => {
	test("returns nonsecret credential data", async () => {
		const response = await credentialsRoutes.request("/validate", {
			headers: { authorization: "Bearer x" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});
