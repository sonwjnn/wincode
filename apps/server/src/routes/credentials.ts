import { Hono } from "hono";
import {
	requireScope,
	unauthorizedHeaders,
	verifyBearerAuth,
} from "../auth/credentials";

export const credentialsRoutes = new Hono().get("/validate", async (c) => {
	const subject = await verifyBearerAuth(c.req.header("authorization") ?? null);
	if (!subject) {
		return c.json({ error: "Unauthorized" }, 401, unauthorizedHeaders);
	}
	if (!requireScope(subject, "chat:write")) {
		return c.json({ error: "Forbidden" }, 403);
	}
	c.header("cache-control", "no-store");
	return c.json({
		credentialType: subject.type,
		expiresAt:
			"expiresAt" in subject
				? (subject.expiresAt?.toISOString() ?? null)
				: null,
		scopes: subject.scopes,
		userId: subject.userId,
	});
});
