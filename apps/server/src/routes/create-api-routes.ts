import { Hono } from "hono";

type ApiRouteDeps = {
	billingRoutes: Hono;
	billingWebhookRoutes: Hono;
	credentialsRoutes: Hono;
	sessionsRoutes: Hono;
};

export const createApiRoutes = ({
	billingRoutes,
	billingWebhookRoutes,
	credentialsRoutes,
	sessionsRoutes,
}: ApiRouteDeps): Hono =>
	new Hono()
		.route("/sessions", sessionsRoutes)
		.route("/billing/webhooks", billingWebhookRoutes)
		.route("/billing", billingRoutes)
		.route("/credentials", credentialsRoutes);
