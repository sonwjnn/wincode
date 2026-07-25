import { auth } from "@wincode/auth";
import { createDrizzleClient } from "@wincode/db/client";
import { env } from "@wincode/env/server";
import { Hono } from "hono";
import {
	requireScope,
	unauthorizedHeaders,
	verifyBearerAuth,
} from "../auth/credentials";
import { getBillingConfig } from "../billing/config";
import { createPolarClient } from "../billing/polar";
import { createBillingRepository } from "../billing/repository";

const returnUrl = new URL("/", env.CORS_ORIGIN).href;

type BillingRouteDeps = {
	getConfig: typeof getBillingConfig;
	createRepository: typeof createBillingRepository;
	createDb: typeof createDrizzleClient;
	verifyAuth: typeof verifyBearerAuth;
	requireScope: typeof requireScope;
	getSession?: typeof auth.api.getSession;
};

const originIsTrusted = (origin: string | undefined) =>
	origin === env.CORS_ORIGIN;

export const createBillingRoutes = (
	deps: BillingRouteDeps = {
		getConfig: getBillingConfig,
		createRepository: createBillingRepository,
		createDb: createDrizzleClient,
		verifyAuth: verifyBearerAuth,
		requireScope,
		getSession: auth.api.getSession,
	}
) =>
	new Hono()
		.get("/usage", async (c) => {
			c.header("cache-control", "no-store");
			const authorization = c.req.header("authorization");
			const subject = authorization
				? await deps.verifyAuth(authorization)
				: await (deps.getSession ?? auth.api.getSession)({
						headers: c.req.raw.headers,
					}).then((session) =>
						session
							? {
									scopes: ["chat:write"],
									type: "oauth" as const,
									userId: session.user.id,
								}
							: null
					);
			if (!subject) {
				return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
			}
			if (!deps.requireScope(subject, "chat:write")) {
				return c.json({ error: "Forbidden" }, 403);
			}
			const config = deps.getConfig();
			if (
				!config ||
				config.dailyGlobalCostCapUsdMicros === undefined ||
				config.fundedRequestInputTokenLimit === undefined ||
				config.fundedRequestOutputTokenLimit === undefined ||
				config.fundedRequestStepLimit === undefined ||
				config.fundedRequestTimeWindowSeconds === undefined ||
				config.priceBookVersion === undefined ||
				config.priceBookEffectiveDate === undefined ||
				(config.mode !== "allowlist-shadow" &&
					config.goRollingQuotaUsdMicros === undefined)
			) {
				return c.json({ error: "Billing unavailable" }, 503);
			}
			const repository = deps.createRepository(deps.createDb(), {
				alphaUserAllowlist: config.alphaUserAllowlist,
				dailyGlobalCostCapUsdMicros: config.dailyGlobalCostCapUsdMicros,
				fundedRequestInputTokenLimit: config.fundedRequestInputTokenLimit,
				fundedRequestOutputTokenLimit: config.fundedRequestOutputTokenLimit,
				fundedRequestStepLimit: config.fundedRequestStepLimit,
				fundedRequestTimeWindowSeconds: config.fundedRequestTimeWindowSeconds,
				goProductId: config.goProductId,
				goRollingQuotaUsdMicros: config.goRollingQuotaUsdMicros,
				mode: config.mode,
				modelKillSwitches: config.modelKillSwitches,
				providerKillSwitches: config.providerKillSwitches,
				priceBookEffectiveAt: new Date(
					`${config.priceBookEffectiveDate}T00:00:00.000Z`
				),
				priceBookVersion: config.priceBookVersion,
			});
			const result = await repository.getUsage(subject.userId);
			if (!result.ok) {
				return c.json({ error: "Billing unavailable" }, 503);
			}
			return c.json({
				mode: config.mode,
				effectiveEligible: result.entitled,
				windowStartedAt: result.windowStartedAt.toISOString(),
				usedUsdMicros: result.usedUsdMicros.toString(),
				quotaUsdMicros: result.quotaUsdMicros?.toString() ?? null,
				remainingUsdMicros:
					result.quotaUsdMicros === null
						? null
						: (result.quotaUsdMicros - result.usedUsdMicros > 0n
								? result.quotaUsdMicros - result.usedUsdMicros
								: 0n
							).toString(),
			});
		})
		.post("/checkout", async (c) => {
			const config = deps.getConfig();
			if (
				!config ||
				(config.mode !== "enforce" && config.mode !== "canary-enforce") ||
				!config.polarToken ||
				!config.goProductId
			) {
				return c.json({ error: "Billing unavailable" }, 503);
			}
			if (!originIsTrusted(c.req.header("origin"))) {
				return c.json({ error: "Forbidden" }, 403);
			}
			const session = await (deps.getSession ?? auth.api.getSession)({
				headers: c.req.raw.headers,
			});
			if (!session) {
				return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
			}
			const checkout = await createPolarClient().checkouts.create({
				products: [config.goProductId],
				externalCustomerId: session.user.id,
				returnUrl,
				successUrl: returnUrl,
			});
			return c.json({ url: checkout.url });
		})
		.post("/portal", async (c) => {
			const config = deps.getConfig();
			if (
				!config ||
				(config.mode !== "enforce" && config.mode !== "canary-enforce")
			) {
				return c.json({ error: "Billing unavailable" }, 503);
			}
			if (!originIsTrusted(c.req.header("origin"))) {
				return c.json({ error: "Forbidden" }, 403);
			}
			const session = await (deps.getSession ?? auth.api.getSession)({
				headers: c.req.raw.headers,
			});
			if (!session) {
				return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
			}
			if (!env.BILLING_POLAR_TOKEN) {
				return c.json({ error: "Billing unavailable" }, 503);
			}
			const portal = await createPolarClient().customerSessions.create({
				externalCustomerId: session.user.id,
				returnUrl,
			});
			return c.json({ url: portal.customerPortalUrl });
		});

export const billingRoutes = createBillingRoutes();
