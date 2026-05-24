import { Hono } from "hono";
import { privateDataRoutes } from "./private-data";
import { sessionsRoutes } from "./sessions";

export const apiRoutes = new Hono()
	.route("/private-data", privateDataRoutes)
	.route("/sessions", sessionsRoutes);
