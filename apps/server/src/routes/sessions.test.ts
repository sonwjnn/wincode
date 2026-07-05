import { describe, expect, mock, test } from "bun:test";

const createCodingAgentStreamResponse = mock(() => new Response("stream-ok"));

mock.module("@wincode/ai/server", () => ({
	codingServerTools: {},
	createCodingAgentStreamResponse,
	resolveChatModel: () => ({
		model: {},
		modelId: "gpt-5.4-mini",
		providerOptions: {},
	}),
}));

const { sessionsRoutes } = await import("./sessions");

describe("POST /:id/chat (transport-only)", () => {
	test("streams from the full message context in the request body", async () => {
		createCodingAgentStreamResponse.mockClear();

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
		expect(createCodingAgentStreamResponse).toHaveBeenCalledTimes(1);
	});

	test("rejects a request missing mode/model", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({ messages: [] }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});
});
