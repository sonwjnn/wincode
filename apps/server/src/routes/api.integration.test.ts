import { expect, mock, test } from "bun:test";
import { Hono } from "hono";

const billingRoutes = new Hono()
	.post("/checkout", (c) => c.text("checkout"))
	.post("/portal", (c) => c.text("portal"));
const billingWebhookRoutes = new Hono().post("/polar", (c) =>
	c.text("webhook")
);

mock.module("./billing", () => ({ billingRoutes }));
mock.module("./billing-webhooks", () => ({ billingWebhookRoutes }));
mock.module("./credentials", () => ({ credentialsRoutes: new Hono() }));
mock.module("./sessions", () => ({ sessionsRoutes: new Hono() }));

const { apiRoutes } = await import("./api");

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
