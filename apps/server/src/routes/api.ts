import { Hono } from "hono";
import { chatRoutes } from "./chat";
import { privateDataRoutes } from "./private-data";

export const apiRoutes = new Hono()
	.route("/chat", chatRoutes)
	.route("/private-data", privateDataRoutes);
