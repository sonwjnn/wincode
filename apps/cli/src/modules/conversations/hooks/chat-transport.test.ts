import { describe, expect, mock, test } from "bun:test";
import type { ChatModelSelection, ResolvedAgentRuntime } from "@wincode/ai";
// Capture the real namespace before registering the module mock so the mock can
// spread it and stay complete. bun test runs every file in one process, so a
// partial mock.module("@wincode/ai/server") would otherwise break sibling test
// files that import names the partial mock omits.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realServer from "@wincode/ai/server";
import type { McpCatalogSnapshot, McpContextValue } from "@/modules/mcp";

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

mock.module("@wincode/ai/server", () => ({
	...realServer,
	createCodingAgent: () => ({}),
	getProviderErrorMessage: () => new Error("provider"),
	resolveDirectChatModel: resolveDirectChatModelMock,
	resolveOpenAIChatModel: resolveOpenAIChatModelMock,
}));

const { createLocalChatTransport } = await import("./local-chat-transport");

const agentRef = { current: "build" as const };
const resolvedAgentRef = {
	current: undefined as ResolvedAgentRuntime | undefined,
};
const hostedResolvedAgentRef = {
	current: {
		instructions: "Build safely.",
		visibleCodingTools: ["read", "write", "edit", "list", "grep"],
	} satisfies ResolvedAgentRuntime,
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
	reconnect: async () => undefined,
	statuses: [],
	...overrides,
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
				hostedResolvedAgentRef,
				modelRef,
				variantRef,
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
				hostedResolvedAgentRef,
				modelRef,
				variantRef,
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
				hostedResolvedAgentRef,
				modelRef,
				variantRef,
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
					visibleCodingTools: ["read", "write", "edit", "list", "grep"],
				},
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
			resolvedAgentRef,
			{ current: { modelId: "gemini-2.5-flash", providerId: "google" } },
			{ current: undefined },
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
