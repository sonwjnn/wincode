import { describe, expect, mock, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai";

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

mock.module("@wincode/ai/server", () => ({
	createCodingAgent: () => ({}),
	getProviderErrorMessage: () => new Error("provider"),
	resolveDirectChatModel: async (selection: ChatModelSelection) => ({
		model: {},
		modelId: selection.modelId,
		providerOptions: {},
	}),
	resolveOpenAIChatModel: resolveOpenAIChatModelMock,
}));

const { createLocalChatTransport } = await import("./local-chat-transport");

const modeRef = { current: "build" as const };
const modelRef = {
	current: { modelId: "gpt-5.4-mini", providerId: "wincode" } as const,
};
const variantRef = { current: undefined as undefined | "high" };

const message = {
	id: "msg-1",
	metadata: {
		mode: "build",
		model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
	},
	parts: [{ text: "hi", type: "text" }],
	role: "user",
} as const;

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
				modeRef,
				modelRef,
				variantRef,
				{ authorize: async () => ({ kind: "api-key", apiKey: "key" }) } as never
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
				modeRef,
				modelRef,
				variantRef,
				{
					authorize: async (providerId: string, received?: AbortSignal) => {
						expect(providerId).toBe("wincode");
						expect(received).toBe(signal);
						return { kind: "bearer", token: "bearer-token" };
					},
				} as never
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

	test("google route uses direct auth", async () => {
		const createStream = mock(async () => new ReadableStream());
		const signal = new AbortController().signal;
		const transport = createLocalChatTransport(
			"session-1",
			modeRef,
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

	test("openai oauth route passes variant to resolveOpenAIChatModel", async () => {
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			modeRef,
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
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			modeRef,
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
	});
});
