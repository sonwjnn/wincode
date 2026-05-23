import { auth } from "@wincode/auth";
import { Hono } from "hono";

export const privateDataRoutes = new Hono().get("/", async (c) => {
	const session = await auth.api.getSession({
		headers: c.req.raw.headers,
	});
	if (!session) {
		return c.json({ error: "Unauthorized" }, 401);
	}
	return c.json({
		message: "This is private",
		user: session.user,
	});
});
