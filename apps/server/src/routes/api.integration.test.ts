import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createApiRoutes } from "./create-api-routes";

const billingRoutes = new Hono()
	.post("/checkout", (c) => c.text("checkout"))
	.post("/portal", (c) => c.text("portal"));
const billingWebhookRoutes = new Hono().post("/polar", (c) =>
	c.text("webhook")
);

const apiRoutes = createApiRoutes({
	billingRoutes,
	billingWebhookRoutes,
	credentialsRoutes: new Hono(),
	sessionsRoutes: new Hono(),
});

test("composes billing webhook and management routes", async () => {
	const webhook = await apiRoutes.request("/billing/webhooks/polar", {
		method: "POST",
	});
	const checkout = await apiRoutes.request("/billing/checkout", {
		method: "POST",
	});
	const portal = await apiRoutes.request("/billing/portal", { method: "POST" });

	expect(webhook.status).toBe(200);
	expect(checkout.status).toBe(200);
	expect(portal.status).toBe(200);
});
