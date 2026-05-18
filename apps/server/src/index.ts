import { devToolsMiddleware } from "@ai-sdk/devtools";
import { google } from "@ai-sdk/google";
import { zValidator } from "@hono/zod-validator";
import { auth } from "@wincode/auth";
import { env } from "@wincode/env/server";
import {
	convertToModelMessages,
	streamText,
	type UIMessage,
	wrapLanguageModel,
} from "ai";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";

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

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

const aiSchema = z.object({
	messages: z.array(z.unknown() as z.ZodType<UIMessage>).min(1),
});

const completionSchema = z.object({
	prompt: z.string().min(1),
});

const routes = app
	.post("/ai", zValidator("json", aiSchema), async (c) => {
		const { messages } = c.req.valid("json");
		const model = wrapLanguageModel({
			model: google("gemini-2.5-flash"),
			middleware: devToolsMiddleware(),
		});
		const result = streamText({
			model,
			messages: await convertToModelMessages(messages),
		});

		return result.toUIMessageStreamResponse();
	})
	.post("/api/completion", zValidator("json", completionSchema), (c) => {
		const { prompt } = c.req.valid("json");
		const result = streamText({
			model: google("gemini-2.5-flash"),
			prompt,
		});
		return result.toTextStreamResponse();
	})
	.get("/api/health-check", (c) => c.json("OK"))
	.get("/api/private-data", async (c) => {
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
	})
	.get("/", (c) => c.text("OK"));

export type AppType = typeof routes;
export default app;
