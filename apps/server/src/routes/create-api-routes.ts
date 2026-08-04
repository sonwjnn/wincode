import type { Env } from "hono";
import { Hono } from "hono";
import type { Schema } from "hono/types";

type ApiRouteDeps<
	TBillingSchema extends Schema,
	TBillingWebhookSchema extends Schema,
	TCredentialsSchema extends Schema,
	TSessionsSchema extends Schema,
> = {
	billingRoutes: Hono<Env, TBillingSchema, string>;
	billingWebhookRoutes: Hono<Env, TBillingWebhookSchema, string>;
	credentialsRoutes: Hono<Env, TCredentialsSchema, string>;
	sessionsRoutes: Hono<Env, TSessionsSchema, string>;
};

export const createApiRoutes = <
	TBillingSchema extends Schema,
	TBillingWebhookSchema extends Schema,
	TCredentialsSchema extends Schema,
	TSessionsSchema extends Schema,
>({
	billingRoutes,
	billingWebhookRoutes,
	credentialsRoutes,
	sessionsRoutes,
}: ApiRouteDeps<
	TBillingSchema,
	TBillingWebhookSchema,
	TCredentialsSchema,
	TSessionsSchema
>) =>
	new Hono()
		.route("/sessions", sessionsRoutes)
		.route("/billing/webhooks", billingWebhookRoutes)
		.route("/billing", billingRoutes)
		.route("/credentials", credentialsRoutes);
