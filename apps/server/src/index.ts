import { env } from "@wincode/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { apiRoutes } from "./routes/api";
import { authRoutes, authWellKnownRoutes } from "./routes/auth";

const app = new Hono();

app.use(logger());
app.use(
	"/*",
	cors({
		origin: env.CORS_ORIGIN,
		allowMethods: ["GET", "POST", "OPTIONS"],
		allowHeaders: ["Content-Type", "Authorization"],
		credentials: true,
	})
);

const routes = app
	.route("/.well-known", authWellKnownRoutes)
	.route("/api/auth", authRoutes)
	.route("/api", apiRoutes);

export type AppType = typeof routes;
export default app;
