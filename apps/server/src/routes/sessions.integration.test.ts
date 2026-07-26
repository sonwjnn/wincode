import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { z } from "zod";

mock.module("@wincode/env/server", () => ({
	env: {
		BETTER_AUTH_URL: "https://auth.example.com/api/auth",
		CORS_ORIGIN: "https://app.example.com",
		DATABASE_URL: "postgres://example",
		WINCODE_API_KEY_PEPPER: "pepperpepperpepperpepperpepperpepper",
	},
}));

mock.module("@wincode/ai", () => ({
	codingModeNameSchema: z.enum(["plan"]),
	codingAgentDataSchemas: {},
	codingMessageMetadataSchema: z.object({
		mode: z.enum(["plan"]).optional(),
		model: z
			.object({ modelId: z.string(), providerId: z.enum(["wincode"]) })
			.optional(),
		responseTimeMs: z.number().int().nonnegative().optional(),
		variant: z.enum(["high", "max"]).optional(),
	}),
	modelVariantSchema: z.enum(["high", "max"]),
	supportedChatModelIdSchema: z.enum(["gpt-5.4-mini", "gpt-5.5"]),
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

const { createSessionsRoutes } = await import("./sessions");

const createCodingAgentStreamResponse = mock(async (input: any) => {
	await input.onStepEnd?.({
		stepNumber: 0,
		usage: {
			inputTokenDetails: { cacheReadTokens: 0n, cacheWriteTokens: 0n },
			inputTokens: 10n,
			outputTokenDetails: { reasoningTokens: 0n },
			outputTokens: 2n,
			totalTokens: 12n,
		},
	});
	await input.onEnd?.({
		steps: [
			{
				stepNumber: 0,
				usage: { inputTokens: 1n, outputTokens: 1n, totalTokens: 2n },
			},
		],
		totalUsage: {
			inputTokenDetails: { cacheReadTokens: 0n, cacheWriteTokens: 0n },
			inputTokens: 1n,
			outputTokenDetails: { reasoningTokens: 0n },
			outputTokens: 1n,
			totalTokens: 2n,
		},
	});
	return new Response(null, { status: 200 });
}) as unknown as typeof import("@wincode/ai/server").createCodingAgentStreamResponse;

const resolveSupportedChatModel = (() => ({
	model: {},
	modelId: "x",
	maxOutputTokens: 32,
	providerOptions: {},
})) as unknown as typeof import("@wincode/ai/server").resolveSupportedChatModel;

const resolveWincodeChatModelSelection = ((model: string) => {
	if (model === "gpt-5.5") {
		throw new Error("Unsupported model");
	}
	return {
		connectionProviderId: "wincode",
		displayName: "GPT-5.4 Mini",
		id: model,
		provider: "openai",
		route: "hosted",
		variants: ["none", "high", "max"],
	};
}) as unknown as typeof import("@wincode/ai/server").resolveWincodeChatModelSelection;

const codingServerTools =
	{} as typeof import("@wincode/ai/server").codingServerTools;

const billingRepository = {
	finalizeRequest: mock(async () => ({
		ok: true,
		reconciliationRequired: false,
	})),
	reserveRequest: mock(async () => ({ ok: true, requestId: "session-1:uuid" })),
	settleStep: mock(async () => ({ ok: true, accruedUsdMicros: 0n })),
	expireStaleActiveRequests: mock(async () => ({ ok: true, expiredCount: 0 })),
};

const sessionsRoutes = createSessionsRoutes({
	codingServerTools,
	createCodingAgentStreamResponse,
	getBillingConfig: () =>
		({
			fundedRequestInputTokenLimit: 1000,
			fundedRequestOutputTokenLimit: 8,
			fundedRequestStepLimit: 3,
			fundedRequestTimeWindowSeconds: 5,
			mode: "allowlist-shadow",
		}) as never,
	getBillingRepository: () => billingRepository as never,
	resolveSupportedChatModel,
	resolveWincodeChatModelSelection,
});

beforeEach(() => {
	billingRepository.finalizeRequest.mockReset();
	billingRepository.reserveRequest.mockReset();
	billingRepository.settleStep.mockReset();
	billingRepository.finalizeRequest.mockImplementation(async () => ({
		ok: true,
		reconciliationRequired: false,
	}));
	billingRepository.reserveRequest.mockImplementation(async () => ({
		ok: true,
		requestId: "session-1:uuid",
	}));
	billingRepository.settleStep.mockImplementation(async () => ({
		ok: true,
		accruedUsdMicros: 0n,
	}));
});

afterEach(() => {
	mock.restore();
});

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
		expect(billingRepository.settleStep).toHaveBeenCalledTimes(1);
		expect(billingRepository.finalizeRequest).toHaveBeenCalledTimes(1);
	});

	test("injects real billing config and repository into lifecycle", async () => {
		await sessionsRoutes.request("/session-9/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(billingRepository.reserveRequest).toHaveBeenCalledTimes(1);
		expect(billingRepository.settleStep).toHaveBeenCalledTimes(1);
		expect(billingRepository.finalizeRequest).toHaveBeenCalledTimes(1);
		expect(billingRepository.reserveRequest).toHaveBeenCalledTimes(1);
	});

	test("bounds funded execution before streaming", async () => {
		const response = await sessionsRoutes.request("/session-13/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(billingRepository.reserveRequest).toHaveBeenCalledTimes(1);
	});

	test("passes resolved runtime identity to billing and funded output cap to stream", async () => {
		await sessionsRoutes.request("/session-14/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(billingRepository.reserveRequest).toHaveBeenCalledWith(
			expect.objectContaining({
				runtimeModel: "gpt-5.4-mini",
				runtimeProvider: "openai",
			})
		);
	});

	test("rejects input beyond conservative hard cap", async () => {
		const response = await sessionsRoutes.request("/session-15/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "u1",
						parts: [{ text: "x".repeat(70_000), type: "text" }],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects disabled billing config as unavailable", async () => {
		const response = await createSessionsRoutes({
			getBillingConfig: () => null,
			getBillingRepository: () => billingRepository as never,
		}).request("/session-11/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(response.status).toBe(503);
	});

	test("rejects reserve deny before stream", async () => {
		billingRepository.reserveRequest.mockImplementationOnce(async () => ({
			kind: "denied",
			ok: false,
			reason: "daily-cap",
			requestId: "session-12:uuid",
		}));
		const response = await sessionsRoutes.request("/session-12/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Billing reserve denied: daily-cap",
		});
	});

	test("rejects multimodal predispatch parts", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-image",
						parts: [
							{
								mediaType: "image/png",
								type: "file",
								url: "data:image/png;base64,aGVsbG8=",
							},
						],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("accepts assistant internal continuation parts", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "assistant-1",
						parts: [
							{ text: "thinking", type: "reasoning" },
							{ type: "step-start" },
							{ toolCallId: "call_1", toolName: "read", type: "tool-call" },
							{ toolCallId: "call_1", type: "tool-result" },
						],
						role: "assistant",
					},
					{ id: "user-1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects token-unsafe oversized text", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						parts: [{ text: "x".repeat(5000), type: "text" }],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects funded input after deterministic system/tool overhead", async () => {
		const response = await createSessionsRoutes({
			getBillingConfig: () =>
				({
					fundedRequestInputTokenLimit: 200,
					fundedRequestOutputTokenLimit: 8,
					fundedRequestStepLimit: 3,
					fundedRequestTimeWindowSeconds: 5,
					mode: "allowlist-shadow",
				}) as never,
			getBillingRepository: () => billingRepository as never,
		}).request("/session-16/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects oversized all-context metadata", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						metadata: {
							mode: "plan",
							model: { modelId: "x".repeat(5000), providerId: "wincode" },
						},
						parts: [{ text: "hi", type: "text" }],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
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

	test("rejects malformed message metadata", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						metadata: { mode: "plan", model: "gpt-5.4-mini" },
						parts: [{ text: "hello", type: "text" }],
						role: "user",
					},
				],
				mode: "plan",
				model: "gpt-5.4-mini",
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
					new TextEncoder().encode(
						`"messages":[]${"x".repeat(80 * 1024 * 1024)}`
					)
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
