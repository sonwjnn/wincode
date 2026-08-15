import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
// Capture the real namespace before registering the module mock so the mock can
// spread it and stay complete. bun test runs every file in one process, so a
// partial mock.module("@wincode/ai") would otherwise break sibling test files
// that import names the partial mock omits.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realAi from "@wincode/ai";
import { z } from "zod";

const MCP_TOOL_NAME_REGEX = /^mcp_[A-Za-z0-9_-]+$/;

mock.module("@wincode/env/server", () => ({
	env: {
		BETTER_AUTH_URL: "https://auth.example.com/api/auth",
		CORS_ORIGIN: "https://app.example.com",
		DATABASE_URL: "postgres://example",
		WINCODE_API_KEY_PEPPER: "pepperpepperpepperpepperpepperpepper",
	},
}));

mock.module("@wincode/ai", () => ({
	...realAi,
	formatSkillUserContext: (skill: {
		name: string;
		instructions: string;
		arguments: string;
		contentHash: string;
		source: "agent" | "explicit";
	}) =>
		`<untrusted-skill-context name="${skill.name}" source="${skill.source}" content-hash="${skill.contentHash}">\n${skill.instructions}\n<arguments>${skill.arguments}</arguments>\n</untrusted-skill-context>`,
	skillContextSchema: z.object({
		name: z.string(),
		instructions: z.string(),
		arguments: z.string(),
	}),
	codingAgentDataSchemas: {},
	mcpToolManifestSchema: z
		.array(
			z
				.object({
					name: z.string().min(1).max(64).regex(MCP_TOOL_NAME_REGEX),
					description: z.string().max(8 * 1024),
					inputSchema: z.record(z.string(), z.unknown()),
				})
				.strict()
		)
		.max(128)
		.superRefine((tools, context) => {
			const names = new Set<string>();
			for (const tool of tools) {
				if (names.has(tool.name)) {
					context.addIssue({ code: "custom", message: "duplicate tool name" });
				}
				names.add(tool.name);
			}
			if (
				new TextEncoder().encode(JSON.stringify(tools)).byteLength >
				256 * 1024
			) {
				context.addIssue({
					code: "custom",
					message: "manifest exceeds byte limit",
				});
			}
		}),
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

const validMcpTool = {
	description: "Reads files",
	inputSchema: { type: "object", properties: {}, required: [] },
	name: "mcp_read",
};
const buildAgent = {
	billingKind: "build",
	instructions: "Build safely.",
	mcpTools: [],
	visibleCodingTools: ["read", "write", "edit", "list", "grep"],
} as const;
const planAgent = {
	billingKind: "plan",
	instructions: "Plan without editing.",
	mcpTools: [],
	visibleCodingTools: ["read", "list", "grep"],
} as const;

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
				agent: planAgent,
				model: "gpt-5.4-mini",
				persist: false,
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
				agent: planAgent,
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
				agent: planAgent,
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
				agent: planAgent,
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
				agent: planAgent,
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("forwards valid Build MCP manifest as active tools", async () => {
		const buildStream = mock(async (input: any) => {
			await input.onStepEnd?.({
				stepNumber: 0,
				usage: { inputTokens: 1n, outputTokens: 1n, totalTokens: 2n },
			});
			await input.onEnd?.({
				steps: [],
				totalUsage: { inputTokens: 1n, outputTokens: 1n, totalTokens: 2n },
			});
			return new Response(null, { status: 200 });
		});
		const buildRoutes = createSessionsRoutes({
			codingServerTools,
			createCodingAgentStreamResponse: buildStream as never,
			getBillingConfig: () =>
				({
					fundedRequestInputTokenLimit: 2000,
					fundedRequestOutputTokenLimit: 8,
					fundedRequestStepLimit: 3,
					fundedRequestTimeWindowSeconds: 5,
					mode: "allowlist-shadow",
				}) as never,
			getBillingRepository: () => billingRepository as never,
			resolveSupportedChatModel,
			resolveWincodeChatModelSelection,
		});
		const response = await buildRoutes.request("/session-mcp/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				agent: { ...buildAgent, mcpTools: [validMcpTool] },
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(buildStream).toHaveBeenCalledWith(
			expect.objectContaining({ mcpTools: [validMcpTool] })
		);
	});

	test("forwards completed historical dynamic tool parts without activating tool", async () => {
		const historicalRoutes = createSessionsRoutes({
			codingServerTools,
			createCodingAgentStreamResponse,
			getBillingConfig: () =>
				({
					fundedRequestInputTokenLimit: 2000,
					fundedRequestOutputTokenLimit: 8,
					fundedRequestStepLimit: 3,
					fundedRequestTimeWindowSeconds: 5,
					mode: "allowlist-shadow",
				}) as never,
			getBillingRepository: () => billingRepository as never,
			resolveSupportedChatModel,
			resolveWincodeChatModelSelection,
		});
		const response = await historicalRoutes.request(
			"/session-mcp-history/chat",
			{
				body: JSON.stringify({
					messages: [
						{
							id: "assistant-1",
							parts: [
								{
									input: {},
									output: {},
									state: "output-available",
									toolCallId: "call-history",
									toolName: "mcp_historical_read_12345678",
									type: "dynamic-tool",
								},
							],
							role: "assistant",
						},
						{
							id: "user-2",
							parts: [{ text: "continue", type: "text" }],
							role: "user",
						},
					],
					agent: buildAgent,
					model: "gpt-5.4-mini",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			}
		);

		expect(response.status).toBe(200);
		expect(createCodingAgentStreamResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				mcpTools: [],
				uiMessages: expect.arrayContaining([
					expect.objectContaining({ id: "assistant-1" }),
				]),
			})
		);
	});

	test("rejects malformed MCP manifest entries and oversized manifests", async () => {
		for (const mcpTools of [
			null,
			[{ ...validMcpTool, name: "bad" }],
			[{ ...validMcpTool, inputSchema: [] }],
			[{ ...validMcpTool, description: "x".repeat(256 * 1024) }],
		]) {
			const response = await sessionsRoutes.request("/session-mcp/chat", {
				body: JSON.stringify({
					messages: [
						{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
					],
					agent: { ...buildAgent, mcpTools },
					model: "gpt-5.4-mini",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			expect(response.status).toBe(400);
		}
	});

	test("rejects invalid or privacy-expanding Agent descriptors", async () => {
		for (const agent of [
			{ ...buildAgent, instructions: "" },
			{ ...buildAgent, instructions: "x".repeat(12_001) },
			{ ...buildAgent, visibleCodingTools: ["read", "read"] },
			{ ...buildAgent, configuredAgentName: "private-reviewer" },
		]) {
			const response = await sessionsRoutes.request("/session-agent/chat", {
				body: JSON.stringify({
					agent,
					messages: [
						{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
					],
					model: "gpt-5.4-mini",
				}),
				headers: { "content-type": "application/json" },
				method: "POST",
			});
			expect(response.status).toBe(400);
		}
	});

	test("rejects shell from hosted descriptors even though it is a known tool name", async () => {
		// `shell` joined the coding tool catalog but is CLI-only (ADR-0005):
		// the hosted descriptor accepts the name in isolation yet rejects any
		// descriptor that would execute it on the hosted runtime.
		const response = await sessionsRoutes.request("/session-shell/chat", {
			body: JSON.stringify({
				agent: {
					...buildAgent,
					visibleCodingTools: ["read", "shell"],
				},
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Bad Request");
	});

	test("persists custom billing identity and removes configured Agent identity", async () => {
		const response = await sessionsRoutes.request("/session-custom/chat", {
			body: JSON.stringify({
				agent: {
					billingKind: "custom",
					instructions: "Review carefully.",
					mcpTools: [],
					visibleCodingTools: ["read", "grep"],
				},
				messages: [
					{
						id: "u1",
						metadata: {
							agent: "private-reviewer",
							model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						},
						parts: [{ text: "hi", type: "text" }],
						role: "user",
					},
				],
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(billingRepository.reserveRequest).toHaveBeenCalledWith(
			expect.objectContaining({ mode: "custom" })
		);
		expect(createCodingAgentStreamResponse).toHaveBeenLastCalledWith(
			expect.objectContaining({
				resolvedAgent: {
					instructions: "Review carefully.",
					visibleCodingTools: ["read", "grep"],
				},
				uiMessages: [
					expect.objectContaining({
						metadata: expect.not.objectContaining({
							agent: "private-reviewer",
						}),
					}),
				],
			})
		);
	});

	test("accepts policy-filtered MCP tools for a Plan descriptor", async () => {
		const response = await sessionsRoutes.request("/session-mcp/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				agent: { ...planAgent, mcpTools: [validMcpTool] },
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		expect(response.status).toBe(200);
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
				agent: planAgent,
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
				agent: planAgent,
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
				agent: planAgent,
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
				agent: planAgent,
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
				agent: planAgent,
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("does not count durable skill metadata alongside top-level skill", async () => {
		const skill = {
			arguments: "",
			contentHash: "skill-hash",
			instructions: "i".repeat(700),
			name: "large-skill",
			source: "explicit",
		};
		const response = await createSessionsRoutes({
			codingServerTools,
			createCodingAgentStreamResponse,
			getBillingConfig: () =>
				({
					fundedRequestInputTokenLimit: 2000,
					fundedRequestOutputTokenLimit: 8,
					fundedRequestStepLimit: 3,
					fundedRequestTimeWindowSeconds: 5,
					mode: "allowlist-shadow",
				}) as never,
			getBillingRepository: () => billingRepository as never,
			resolveSupportedChatModel,
			resolveWincodeChatModelSelection,
		}).request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						metadata: { skill: { ...skill, contentHash: "skill-hash" } },
						parts: [{ text: "hi", type: "text" }],
						role: "user",
					},
				],
				agent: planAgent,
				model: "gpt-5.4-mini",
				skill,
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
	});

	test("rejects funded input after deterministic system/tool overhead", async () => {
		(
			createCodingAgentStreamResponse as unknown as { mockClear: () => void }
		).mockClear();
		const config = () =>
			({
				fundedRequestInputTokenLimit: 1000,
				fundedRequestOutputTokenLimit: 8,
				fundedRequestStepLimit: 3,
				fundedRequestTimeWindowSeconds: 5,
				mode: "allowlist-shadow",
			}) as never;
		const request = {
			messages: [
				{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
			],
			agent: buildAgent,
			model: "gpt-5.4-mini",
		};
		const withoutManifest = await createSessionsRoutes({
			codingServerTools,
			createCodingAgentStreamResponse,
			getBillingConfig: config,
			getBillingRepository: () => billingRepository as never,
			resolveSupportedChatModel,
			resolveWincodeChatModelSelection,
		}).request("/session-16/chat", {
			body: JSON.stringify(request),
			headers: { "content-type": "application/json" },
			method: "POST",
		});
		const response = await createSessionsRoutes({
			codingServerTools,
			createCodingAgentStreamResponse,
			getBillingConfig: () => config(),
			getBillingRepository: () => billingRepository as never,
			resolveSupportedChatModel,
			resolveWincodeChatModelSelection,
		}).request("/session-16/chat", {
			body: JSON.stringify({
				...request,
				agent: {
					...buildAgent,
					mcpTools: [{ ...validMcpTool, description: "x".repeat(4000) }],
				},
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(withoutManifest.status).toBe(200);
		expect(response.status).toBe(400);
		expect(createCodingAgentStreamResponse).toHaveBeenCalledTimes(1);
	});

	test("rejects oversized all-context metadata", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						metadata: {
							agent: "plan",
							model: { modelId: "x".repeat(5000), providerId: "wincode" },
						},
						parts: [{ text: "hi", type: "text" }],
						role: "user",
					},
				],
				agent: planAgent,
				model: "gpt-5.4-mini",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects a request missing Agent descriptor and model", async () => {
		const response = await sessionsRoutes.request("/session-1/chat", {
			body: JSON.stringify({ messages: [] }),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects the legacy hosted mode payload", async () => {
		const response = await sessionsRoutes.request("/session-legacy/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				mode: "build",
				model: "gpt-5.4-mini",
			}),
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
				agent: planAgent,
				model: "gpt-5.5",
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});

	test("rejects legacy mode metadata in hosted requests", async () => {
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
				agent: planAgent,
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

describe("hosted session skill tool forwarding", () => {
	const skillTool = {
		description: "<available_skills>\n- review: review code",
		inputSchema: {
			additionalProperties: false,
			properties: { name: { type: "string" } },
			required: ["name"],
			type: "object",
		},
		name: "skill",
	};

	beforeEach(() => {
		(
			createCodingAgentStreamResponse as unknown as { mockClear: () => void }
		).mockClear();
	});

	test("forwards the CLI-built skill tool definition to the model loop", async () => {
		const response = await sessionsRoutes.request("/session-skill/chat", {
			body: JSON.stringify({
				messages: [
					{
						id: "user-1",
						metadata: {
							skill: {
								arguments: "focus",
								contentHash: "hash-skill",
								instructions: "Review code.",
								name: "review",
								source: "explicit",
							},
						},
						parts: [{ text: "/review", type: "text" }],
						role: "user",
					},
				],
				agent: planAgent,
				model: "gpt-5.4-mini",
				skill: {
					arguments: "focus",
					contentHash: "hash-skill",
					instructions: "Review code.",
					name: "review",
					source: "explicit",
				},
				skillTool,
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(200);
		expect(createCodingAgentStreamResponse).toHaveBeenCalledWith(
			expect.objectContaining({
				skill: {
					arguments: "focus",
					contentHash: "hash-skill",
					instructions: "Review code.",
					name: "review",
					source: "explicit",
				},
				skillTool,
			})
		);
	});

	test("rejects malformed skill tool definitions", async () => {
		const response = await sessionsRoutes.request("/session-skill-bad/chat", {
			body: JSON.stringify({
				messages: [
					{ id: "u1", parts: [{ text: "hi", type: "text" }], role: "user" },
				],
				agent: planAgent,
				model: "gpt-5.4-mini",
				skillTool: { description: "x", name: "load_skill" },
			}),
			headers: { "content-type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(400);
	});
});
