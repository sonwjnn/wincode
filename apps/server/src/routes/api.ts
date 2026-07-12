import { Hono } from "hono";
import { credentialsRoutes } from "./credentials";
import { sessionsRoutes } from "./sessions";

export const apiRoutes = new Hono()
	.route("/sessions", sessionsRoutes)
	.route("/credentials", credentialsRoutes);
