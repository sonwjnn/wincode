import { billingRoutes } from "./billing";
import { billingWebhookRoutes } from "./billing-webhooks";
import { createApiRoutes } from "./create-api-routes";
import { credentialsRoutes } from "./credentials";
import { sessionsRoutes } from "./sessions";

export const apiRoutes = createApiRoutes({
	billingRoutes,
	billingWebhookRoutes,
	credentialsRoutes,
	sessionsRoutes,
});
