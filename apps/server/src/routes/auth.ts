import { auth } from "@wincode/auth";
import { Hono } from "hono";

export const authRoutes = new Hono().on(["GET", "POST"], "/*", (c) =>
	auth.handler(c.req.raw)
);
