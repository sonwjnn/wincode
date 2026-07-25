import { Hono } from "hono";
import { billingRoutes } from "./billing";
import { billingWebhookRoutes } from "./billing-webhooks";
import { credentialsRoutes } from "./credentials";
import { sessionsRoutes } from "./sessions";

export const apiRoutes = new Hono()
	.route("/sessions", sessionsRoutes)
	.route("/billing/webhooks", billingWebhookRoutes)
	.route("/billing", billingRoutes)
	.route("/credentials", credentialsRoutes);
