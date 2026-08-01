import type { Env } from "hono";
import { Hono } from "hono";
import type { Schema } from "hono/types";

type ApiRouteDeps<
	TBillingRoutes extends Hono<Env, Schema, string>,
	TBillingWebhookRoutes extends Hono<Env, Schema, string>,
	TCredentialsRoutes extends Hono<Env, Schema, string>,
	TSessionsRoutes extends Hono<Env, Schema, string>,
> = {
	billingRoutes: TBillingRoutes;
	billingWebhookRoutes: TBillingWebhookRoutes;
	credentialsRoutes: TCredentialsRoutes;
	sessionsRoutes: TSessionsRoutes;
};

export const createApiRoutes = <
	TBillingRoutes extends Hono<Env, Schema, string>,
	TBillingWebhookRoutes extends Hono<Env, Schema, string>,
	TCredentialsRoutes extends Hono<Env, Schema, string>,
	TSessionsRoutes extends Hono<Env, Schema, string>,
>({
	billingRoutes,
	billingWebhookRoutes,
	credentialsRoutes,
	sessionsRoutes,
}: ApiRouteDeps<
	TBillingRoutes,
	TBillingWebhookRoutes,
	TCredentialsRoutes,
	TSessionsRoutes
>) =>
	new Hono()
		.route("/sessions", sessionsRoutes)
		.route("/billing/webhooks", billingWebhookRoutes)
		.route("/billing", billingRoutes)
		.route("/credentials", credentialsRoutes);
