import { describe, expect, mock, test } from "bun:test";
import type { BillingRepository } from "../billing/repository";

mock.module("@wincode/env/server", () => ({
	env: {
		BETTER_AUTH_URL: "https://auth.example.com",
		BILLING_MODE: "enforce",
		BILLING_GO_PRODUCT_ID: "prod_go",
		BILLING_POLAR_ENVIRONMENT: "sandbox",
		BILLING_POLAR_TOKEN: "token",
		BILLING_POLAR_WEBHOOK_SECRET: "secret",
		BILLING_DAILY_GLOBAL_COST_CAP_USD_MICROS: "1",
		BILLING_FUNDED_REQUEST_INPUT_TOKEN_LIMIT: "1",
		BILLING_FUNDED_REQUEST_OUTPUT_TOKEN_LIMIT: "1",
		BILLING_FUNDED_REQUEST_STEP_LIMIT: "1",
		BILLING_FUNDED_REQUEST_TIME_WINDOW_SECONDS: "1",
		BILLING_GO_ROLLING_QUOTA_USD_MICROS: "1",
		BILLING_PRICE_BOOK_VERSION: "2026-07-19",
		BILLING_PRICE_BOOK_EFFECTIVE_DATE: "2026-07-19",
		CORS_ORIGIN: "https://app.example.com",
	},
}));

mock.module("@wincode/auth", () => ({
	auth: { api: { getSession: async () => ({ user: { id: "user-1" } }) } },
}));

const checkoutCreate = mock(async () => ({
	url: "https://checkout.example.com",
}));
const portalCreate = mock(async () => ({
	customerPortalUrl: "https://portal.example.com",
}));

mock.module("../billing/polar", () => ({
	createPolarClient: () => ({
		checkouts: { create: checkoutCreate },
		customerSessions: { create: portalCreate },
	}),
}));

mock.module("../auth/credentials", () => ({
	requireScope: () => true,
	unauthorizedHeaders: { "WWW-Authenticate": 'Bearer realm="api"' },
	verifyBearerAuth: async () => ({
		scopes: ["chat:write"],
		type: "oauth",
		userId: "user-1",
	}),
}));

const getUsage = mock(async () => ({
	entitled: true,
	ok: true,
	quotaUsdMicros: 1000000000000000000n,
	usedUsdMicros: 250000000000000001n,
	windowStartedAt: new Date("2026-01-01T00:00:00.000Z"),
}));
const fakeConfig = () => ({
	polarEnvironment: "sandbox" as const,
	alphaUserAllowlist: new Set(["user-1"]),
	dailyGlobalCostCapUsdMicros: 1n,
	fundedRequestInputTokenLimit: 1n,
	fundedRequestOutputTokenLimit: 1n,
	fundedRequestStepLimit: 1n,
	fundedRequestTimeWindowSeconds: 1n,
	goProductId: "prod_go",
	goRollingQuotaUsdMicros: 1000000000000000000n,
	mode: "enforce" as const,
	modelKillSwitches: new Set<string>(),
	priceBookEffectiveDate: "2026-07-19",
	priceBookVersion: "2026-07-19",
	providerKillSwitches: new Set<string>(),
});

const { billingRoutes, createBillingRoutes } = await import("./billing");
const usageRoutes = createBillingRoutes({
	createDb: () => ({}) as never,
	createRepository: () => ({ getUsage }) as unknown as BillingRepository,
	getConfig: fakeConfig,
	requireScope: () => true,
	verifyAuth: async () => ({
		scopes: ["chat:write"],
		type: "oauth" as const,
		userId: "user-1",
	}),
});

describe("billing routes", () => {
	test("creates checkout for fixed go product", async () => {
		const response = await billingRoutes.request("/checkout", {
			method: "POST",
			headers: { Origin: "https://app.example.com" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: "https://checkout.example.com",
		});
	});

	test("creates portal session for authenticated user", async () => {
		const response = await billingRoutes.request("/portal", {
			method: "POST",
			headers: { Origin: "https://app.example.com" },
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			url: "https://portal.example.com",
		});
	});

	test("uses browser session for billing management", async () => {
		const response = await billingRoutes.request("/checkout", {
			method: "POST",
			headers: { Origin: "https://app.example.com" },
		});
		expect(response.status).toBe(200);
	});

	test("returns usage with decimal totals and remaining amount", async () => {
		const response = await usageRoutes.request("/usage", {
			headers: { Authorization: "Bearer token" },
		});
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			effectiveEligible: true,
			mode: "enforce",
			quotaUsdMicros: "1000000000000000000",
			remainingUsdMicros: "749999999999999999",
			usedUsdMicros: "250000000000000001",
			windowStartedAt: "2026-01-01T00:00:00.000Z",
		});
	});

	test("requires chat scope", async () => {
		const scopedRoutes = createBillingRoutes({
			createDb: () => ({}) as never,
			createRepository: () => ({ getUsage }) as unknown as BillingRepository,
			getConfig: fakeConfig,
			requireScope: () => false,
			verifyAuth: async () => ({ scopes: [], type: "oauth", userId: "user-1" }),
		});
		const response = await scopedRoutes.request("/usage");
		expect(response.status).toBe(403);
	});
});
