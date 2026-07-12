import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";

mock.module("@wincode/env/server", () => ({
	env: {
		BETTER_AUTH_URL: "https://auth.example.com",
		CORS_ORIGIN: "https://app.example.com",
		DATABASE_URL: "postgres://example",
		WINCODE_API_KEY_PEPPER: "pepperpepperpepperpepperpepperpepper",
	},
}));

mock.module("@wincode/ai", () => ({
	codingModeNameSchema: z.enum(["plan"]),
	codingAgentDataSchemas: {},
	supportedChatModelIdSchema: z.enum(["gpt-5.4-mini", "gpt-5.5"]),
}));

mock.module("@wincode/ai/server", () => ({
	codingServerTools: {},
	createCodingAgentStreamResponse: () => new Response(null, { status: 200 }),
	resolveSupportedChatModel: () => ({
		model: {},
		modelId: "x",
		providerOptions: {},
	}),
	resolveWincodeChatModelSelection: (model: string) => {
		if (model === "gpt-5.5") {
			throw new Error("Unsupported model");
		}
		return model;
	},
}));

let currentSubject: { scopes: string[]; type: "oauth"; userId: string } | null =
	{
		scopes: ["chat:write"],
		type: "oauth",
		userId: "user-1",
	};

mock.module("../auth/credentials", () => ({
	requireScope: () => true,
	verifyBearerAuth: async () => currentSubject,
	unauthorizedHeaders: { "WWW-Authenticate": 'Bearer realm="api"' },
}));

const { sessionsRoutes } = await import("./sessions");

describe("POST /:id/chat (transport-only)", () => {
	test("streams from the full message context in the request body", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						parts: [{ text: "hello", type: "text" }],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.4-mini",
				sendReasoning: true,
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
	});

	test("rejects a request missing mode/model", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({ messages: [] }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects direct non-wincode model ids before streaming", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						parts: [{ text: "hello", type: "text" }],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.5",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects unauthenticated requests before body validation", async () => {
		currentSubject = null;
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: "{not json",
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		currentSubject = {
			scopes: ["chat:write"],
			type: "oauth",
			userId: "user-1",
		};
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Bearer realm="api"');
	});

	test("rejects large unauthenticated bodies before parsing", async () => {
		currentSubject = null;
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: "x".repeat(300_000),
			headers: {
				"content-type": "application/json",
				"content-length": "300000",
			},
			method: "POST",
		});
		currentSubject = {
			scopes: ["chat:write"],
			type: "oauth",
			userId: "user-1",
		};
		expect(response.status).toBe(401);
	});

	test("rejects oversized authenticated chunked bodies", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("{"));
				controller.enqueue(
					new TextEncoder().encode(`"messages":[]${"x".repeat(300_000)}`)
				);
				controller.close();
			},
		});
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: stream,
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(response.status).toBe(400);
	});
});
