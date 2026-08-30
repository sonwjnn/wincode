import { describe, expect, mock, test } from "bun:test";
import type { ChatModelSelection, ResolvedAgentRuntime } from "@wincode/ai";
// Capture the real namespace before registering the module mock so the mock can
// spread it and stay complete. bun test runs every file in one process, so a
// partial mock.module("@wincode/ai/server") would otherwise break sibling test
// files that import names the partial mock omits.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realServer from "@wincode/ai/server";
import { buildAgentRegistry } from "@/modules/agents";
import type { McpCatalogSnapshot, McpContextValue } from "@/modules/mcp";
import type { ConfigSnapshot } from "@/shared/config/config-store";

const resolveOpenAIChatModelMock = mock(
	async (
		modelId: string,
		_options: unknown,
		variantOptions?: { variant?: string }
	) => ({
		model: {},
		modelId,
		providerOptions: {},
		variantOptions,
	})
);
const resolveDirectChatModelMock = mock(
	async (selection: ChatModelSelection, apiKey: string, options: unknown) => ({
		model: {},
		modelId: selection.modelId,
		providerOptions: { apiKey, options },
	})
);
const createCodingAgentMock = mock((_options: unknown) => ({}));

mock.module("@wincode/ai/server", () => ({
	...realServer,
	createCodingAgent: createCodingAgentMock,
	getProviderErrorMessage: () => new Error("provider"),
	resolveDirectChatModel: resolveDirectChatModelMock,
	resolveOpenAIChatModel: resolveOpenAIChatModelMock,
}));

const { createLocalChatTransport } = await import("./local-chat-transport");

const agentRef = { current: "build" as const };
const resolvedAgentRef = {
	current: undefined as ResolvedAgentRuntime | undefined,
};
const modelRef = {
	current: { modelId: "gpt-5.4-mini", providerId: "wincode" } as const,
};
const variantRef = { current: undefined as undefined | "high" };

const message = {
	id: "msg-1",
	metadata: {
		agent: "build",
		model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
	},
	parts: [{ text: "hi", type: "text" }],
	role: "user",
} as const;

const manifest = [
	{
		description: "Echo tool",
		inputSchema: { type: "object" },
		name: "mcp_demo_echo",
	},
];

const makeSnapshot = (
	overrides: Partial<McpCatalogSnapshot> = {}
): McpCatalogSnapshot => ({
	agent: "build",
	id: "snap-1",
	manifest: [],
	tools: new Map(),
	...overrides,
});

const makeMcp = (
	overrides: Partial<McpContextValue> = {}
): McpContextValue => ({
	close: async () => undefined,
	createSnapshot: async () => makeSnapshot(),
	handleDynamicToolCall: () => undefined,
	initialize: async () => undefined,
	isLoading: false,
	reconnect: async () => undefined,
	statuses: [],
	toggle: async () => undefined,
	...overrides,
});

// The default registry: only the shipped built-ins, all models available.
const makeRegistry = () =>
	buildAgentRegistry({
		diagnostics: [],
		document: {} as ConfigSnapshot["document"],
		sourceFor: () => undefined,
		sources: [],
	});

describe("chat transport", () => {
	test("routing transport uses wincode authorization dto", async () => {
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: {
					sessions: {
						":id": {
							chat: {
								$url: ({ param }: { param: { id: string } }) =>
									new URL(`https://example.test/sessions/${param.id}/chat`),
							},
						},
					},
				},
			}),
		}));
		const { createRoutingChatTransport } = await import(
			"./routing-chat-transport"
		);
		const fetchMock = mock(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					})
				)
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const transport = createRoutingChatTransport(
				"session-1",
				agentRef,
				modelRef,
				variantRef,
				makeRegistry(),
				{
					authorize: async () => ({ kind: "api-key", apiKey: "key" }),
				} as never,
				makeMcp()
			);
			await transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [message] as never,
				metadata: undefined,
				trigger: "submit-message",
			});
			const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
				unknown,
				{ headers?: unknown },
			];
			expect(
				new Headers(requestInit.headers as never).get("authorization")
			).toBe("Bearer key");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routing transport uses hosted bearer token", async () => {
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: {
					sessions: {
						":id": {
							chat: {
								$url: ({ param }: { param: { id: string } }) =>
									new URL(`https://example.test/sessions/${param.id}/chat`),
							},
						},
					},
				},
			}),
		}));
		const { createRoutingChatTransport } = await import(
			"./routing-chat-transport"
		);
		const fetchMock = mock(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					})
				)
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const signal = new AbortController().signal;
			const transport = createRoutingChatTransport(
				"session-1",
				agentRef,
				modelRef,
				variantRef,
				makeRegistry(),
				{
					authorize: async (providerId: string, received?: AbortSignal) => {
						expect(providerId).toBe("wincode");
						expect(received).toBe(signal);
						return { kind: "bearer", token: "bearer-token" };
					},
				} as never,
				makeMcp()
			);
			await transport.sendMessages({
				abortSignal: signal,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [message] as never,
				metadata: undefined,
				trigger: "submit-message",
			});
			const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
				unknown,
				{ headers?: unknown },
			];
			expect(
				new Headers(requestInit.headers as never).get("authorization")
			).toBe("Bearer bearer-token");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routing transport snapshots MCP tools into hosted build requests", async () => {
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: {
					sessions: {
						":id": {
							chat: {
								$url: ({ param }: { param: { id: string } }) =>
									new URL(`https://example.test/sessions/${param.id}/chat`),
							},
						},
					},
				},
			}),
		}));
		const { createRoutingChatTransport } = await import(
			"./routing-chat-transport"
		);
		const fetchMock = mock(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					})
				)
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const snapshot = makeSnapshot({ manifest });
			const createSnapshot = mock(async () => snapshot);
			const transport = createRoutingChatTransport(
				"session-1",
				agentRef,
				modelRef,
				variantRef,
				makeRegistry(),
				{
					authorize: async () => ({ kind: "api-key", apiKey: "key" }),
				} as never,
				makeMcp({ createSnapshot })
			);
			await transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [message] as never,
				metadata: undefined,
				trigger: "submit-message",
			});
			expect(createSnapshot).toHaveBeenCalledWith("build");
			const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
				unknown,
				{ body?: string },
			];
			expect(JSON.parse(requestInit.body ?? "{}")).toMatchObject({
				agent: {
					billingKind: "build",
					mcpTools: manifest,
					visibleCodingTools: ["read", "write", "edit", "list", "glob", "grep"],
				},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routing transport carries the last-used variant when the newest turn omits it", async () => {
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: {
					sessions: {
						":id": {
							chat: {
								$url: ({ param }: { param: { id: string } }) =>
									new URL(`https://example.test/sessions/${param.id}/chat`),
							},
						},
					},
				},
			}),
		}));
		const { createRoutingChatTransport } = await import(
			"./routing-chat-transport"
		);
		const fetchMock = mock(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					})
				)
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			// A resumed conversation: the assistant turn used "high", then a
			// new user message was submitted without re-picking a variant, so
			// the optimistic message metadata dropped it at the JSON round
			// trip and the prompt-config variant ref is undefined.
			const resumedMessages = [
				{
					id: "assistant-1",
					metadata: {
						agent: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: "high",
					},
					parts: [{ text: "done", type: "text" }],
					role: "assistant",
				},
				{
					id: "user-2",
					metadata: {
						agent: "build",
						model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						variant: undefined,
					},
					parts: [{ text: "continue", type: "text" }],
					role: "user",
				},
			] as const;
			const transport = createRoutingChatTransport(
				"session-1",
				agentRef,
				modelRef,
				{ current: undefined },
				makeRegistry(),
				{
					authorize: async () => ({ kind: "api-key", apiKey: "key" }),
				} as never,
				makeMcp({ createSnapshot: async () => makeSnapshot() })
			);
			await transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: resumedMessages as never,
				metadata: undefined,
				trigger: "submit-message",
			});
			const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
				unknown,
				{ body?: string },
			];
			const body = JSON.parse(requestInit.body ?? "{}");
			expect(body.variant).toBe("high");
			expect(body.model).toBe("gpt-5.4-mini");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routing transport forwards the skill tool and explicit skill to hosted requests", async () => {
		mock.module("@/shared/api/hono-client", () => ({
			getHonoClient: () => ({
				api: {
					sessions: {
						":id": {
							chat: {
								$url: ({ param }: { param: { id: string } }) =>
									new URL(`https://example.test/sessions/${param.id}/chat`),
							},
						},
					},
				},
			}),
		}));
		const { createRoutingChatTransport } = await import(
			"./routing-chat-transport"
		);
		const fetchMock = mock(
			async () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.close();
						},
					})
				)
		);
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const skillMessage = {
				id: "msg-skill",
				metadata: {
					agent: "build",
					model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
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
			} as const;
			const transport = createRoutingChatTransport(
				"session-1",
				agentRef,
				modelRef,
				variantRef,
				makeRegistry(),
				{
					authorize: async () => ({ kind: "api-key", apiKey: "key" }),
				} as never,
				makeMcp({ createSnapshot: async () => makeSnapshot() }),
				{
					current: {
						description: "<available_skills>\n- review: review skills",
						inputSchema: {
							additionalProperties: false as const,
							properties: { name: { type: "string" as const } },
							required: ["name"] as const,
							type: "object" as const,
						},
						name: "skill" as const,
					},
				}
			);
			await transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [skillMessage] as never,
				metadata: undefined,
				trigger: "submit-message",
			});
			const [, requestInit] = fetchMock.mock.calls[0] as unknown as [
				unknown,
				{ body?: string },
			];
			const body = JSON.parse(requestInit.body ?? "{}");
			expect(body.skill).toEqual({
				arguments: "focus",
				contentHash: "hash-skill",
				instructions: "Review code.",
				name: "review",
				source: "explicit",
			});
			expect(body.skillTool).toEqual({
				description: "<available_skills>\n- review: review skills",
				inputSchema: {
					additionalProperties: false,
					properties: { name: { type: "string" } },
					required: ["name"],
					type: "object",
				},
				name: "skill",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routing transport passes the snapshot to the direct transport", async () => {
		const capturedSnapshot: { current: McpCatalogSnapshot | undefined } = {
			current: undefined,
		};
		mock.module("./local-chat-transport", () => ({
			createLocalChatTransport: (
				_sessionId: string,
				_resolvedAgentRef: unknown,
				_modelRef: unknown,
				_variantRef: unknown,
				_connections: unknown,
				_createStream: unknown,
				snapshot: McpCatalogSnapshot | undefined
			) => {
				capturedSnapshot.current = snapshot;
				return {
					sendMessages: async () => new ReadableStream(),
					reconnectToStream: async () => null,
				};
			},
		}));
		const snapshot = makeSnapshot({ manifest });
		const createSnapshot = mock(async () => snapshot);
		const { createRoutingChatTransport } = await import(
			"./routing-chat-transport"
		);
		const transport = createRoutingChatTransport(
			"session-1",
			agentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			makeRegistry(),
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			makeMcp({ createSnapshot })
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		expect(createSnapshot).toHaveBeenCalledWith("build");
		expect(capturedSnapshot.current).toBe(snapshot);
	});

	test("local transport omits MCP manifest for empty snapshots", async () => {
		const createStream = mock(
			async (_input: { options?: unknown }) => new ReadableStream()
		);
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			createStream,
			makeSnapshot()
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		const input = createStream.mock.calls[0]?.[0];
		expect(input).toMatchObject({
			options: { model: "gemini-2.5-flash" },
		});
		expect(
			(input as { options: { mcpTools?: unknown } }).options.mcpTools
		).toBeUndefined();
	});

	test("local transport passes the resolved agent runtime into call options", async () => {
		const createStream = mock(
			async (_input: { options?: unknown }) => new ReadableStream()
		);
		const transport = createLocalChatTransport(
			"session-1",
			{
				current: {
					instructions: "Agent-specific instructions.",
					visibleCodingTools: ["read", "list", "grep"],
				},
			},
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		const input = createStream.mock.calls[0]?.[0] as {
			options?: {
				model: string;
				resolvedAgent?: { instructions: string; visibleCodingTools: string[] };
			};
		};
		expect(input.options).toEqual({
			model: "gemini-2.5-flash",
			resolvedAgent: {
				instructions: "Agent-specific instructions.",
				visibleCodingTools: ["read", "list", "grep"],
			},
		});
	});

	test("google route uses direct auth", async () => {
		const createStream = mock(async () => new ReadableStream());
		const signal = new AbortController().signal;
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async (providerId: string, received?: AbortSignal) => {
					expect(providerId).toBe("google");
					expect(received).toBe(signal);
					return { kind: "api-key", apiKey: "google-key" };
				},
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: signal,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		expect(createStream).toHaveBeenCalled();
	});

	test("local transport rejects hosted models with stable error", async () => {
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			modelRef,
			variantRef,
			{
				authorize: mock(async () => ({ kind: "api-key", apiKey: "key" })),
			} as never,
			mock(async () => new ReadableStream())
		);

		await expect(
			transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [] as never,
				metadata: undefined,
				trigger: "submit-message",
			})
		).rejects.toThrow("Local transport requires a direct model");
	});

	test("openai oauth route passes variant to resolveOpenAIChatModel", async () => {
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gpt-5.4-mini", providerId: "openai" } },
			{ current: "high" },
			{
				authorize: async () => ({
					kind: "oauth",
					accessToken: "token",
					accountId: "acct-1",
				}),
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		expect(resolveOpenAIChatModelMock).toHaveBeenCalledWith(
			"gpt-5.4-mini",
			expect.any(Object),
			{ variant: "high" }
		);
	});

	test("openai api key route uses resolveDirectChatModel", async () => {
		resolveOpenAIChatModelMock.mockClear();
		resolveDirectChatModelMock.mockClear();
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gpt-5.4-mini", providerId: "openai" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "openai-key" }),
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		expect(createStream).toHaveBeenCalled();
		expect(resolveDirectChatModelMock).toHaveBeenCalledWith(
			{ modelId: "gpt-5.4-mini", providerId: "openai" },
			"openai-key",
			{ variant: undefined }
		);
		expect(resolveOpenAIChatModelMock).not.toHaveBeenCalled();
	});
});

describe("chat transport skill activation", () => {
	const skillMessage = {
		id: "msg-skill",
		metadata: {
			agent: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
			skill: {
				arguments: "focus on auth",
				contentHash: "hash-skill",
				instructions: "Review code thoroughly.",
				name: "review",
				source: "explicit",
			},
		},
		parts: [{ text: "/review focus on auth", type: "text" }],
		role: "user",
	} as const;

	test("local transport re-injects the skill context into the model loop", async () => {
		const createStream = mock(
			async (_input: { originalMessages?: unknown }) => new ReadableStream()
		);
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [skillMessage] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		const input = createStream.mock.calls[0]?.[0] as {
			originalMessages?: Array<{
				id?: string;
				parts?: Array<{ text?: string }>;
			}>;
		};
		const skillContextMessage = input.originalMessages?.find(
			({ id }) => id === "skill-context"
		);
		expect(skillContextMessage).toBeDefined();
		expect(skillContextMessage?.parts?.[0]?.text).toContain(
			'<untrusted-skill-context name="review" source="explicit" content-hash="hash-skill">'
		);
		expect(skillContextMessage?.parts?.[0]?.text).toContain(
			"Review code thoroughly."
		);
		expect(skillContextMessage?.parts?.[0]?.text).toContain(
			"<arguments>focus on auth</arguments>"
		);
	});

	test("local transport passes the skill tool definition to the agent", async () => {
		createCodingAgentMock.mockClear();
		const createStream = mock(async () => new ReadableStream());
		const skillToolRef = {
			current: {
				description: "<available_skills>\n- review: review skills",
				inputSchema: {
					additionalProperties: false as const,
					properties: { name: { type: "string" as const } },
					required: ["name"] as ["name"],
					type: "object" as const,
				},
				name: "skill" as const,
			},
		};
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			createStream,
			makeSnapshot(),
			skillToolRef
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		const options = createCodingAgentMock.mock.calls[0]?.[0] as {
			skillTool?: { name: string; description: string };
		};
		expect(options.skillTool).toEqual(skillToolRef.current);
	});

	test("local transport omits the skill tool when no catalog is active", async () => {
		createCodingAgentMock.mockClear();
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		const options = createCodingAgentMock.mock.calls[0]?.[0] as {
			skillTool?: unknown;
		};
		expect(options.skillTool).toBeUndefined();
	});

	test("local transport declares the platform shell tool for the model loop", async () => {
		createCodingAgentMock.mockClear();
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
			{
				authorize: async () => ({ kind: "api-key", apiKey: "google-key" }),
			} as never,
			createStream
		);
		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as never,
			metadata: undefined,
			trigger: "submit-message",
		});
		const options = createCodingAgentMock.mock.calls[0]?.[0] as {
			shellTool?: { description: string; inputSchema: unknown };
		};
		expect(options.shellTool).toBeDefined();
		expect(options.shellTool?.description).toContain("/bin/bash -c");
		expect(options.shellTool?.inputSchema).toBeDefined();
	});
});
