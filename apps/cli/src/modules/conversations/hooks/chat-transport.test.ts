import { describe, expect, mock, test } from "bun:test";
import type { ChatModelSelection } from "@wincode/ai";
import { createLocalChatTransport } from "./local-chat-transport";

const modeRef = { current: "build" as const };

describe("chat transport", () => {
	test("routing transport uses latest message metadata", async () => {
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
			async (_input: unknown, _init?: unknown) =>
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
				{
					current: {
						modelId: "gpt-5.5",
						providerId: "openai",
					} satisfies ChatModelSelection,
				},
				{
					getStatus: async () => ({
						connected: true,
						kind: "api-key" as const,
						providerId: "wincode" as const,
					}),
					load: async () => ({ kind: "api-key", apiKey: "key" }),
					replaceValidated: async () => undefined,
				}
			);

			const stream = await transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: new Headers({ "x-trace": "1" }),
				messageId: undefined,
				messages: [
					{
						id: "msg-1",
						metadata: {
							mode: "build",
							model: { modelId: "gpt-5.4-mini", providerId: "wincode" },
						},
						parts: [{ text: "hi", type: "text" }],
						role: "user",
					},
				] as unknown as Parameters<
					typeof transport.sendMessages
				>[0]["messages"],
				metadata: undefined,
				trigger: "submit-message",
			});

			expect(stream).toBeInstanceOf(ReadableStream);
			expect(fetchMock).toHaveBeenCalled();
			expect(
				new Headers(
					(fetchMock.mock.calls[0]?.[1] as { headers?: unknown })
						?.headers as never
				).get("authorization")
			).toBe("Bearer key");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("routing transport rejects invalid legacy metadata", async () => {
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
		const transport = createRoutingChatTransport(
			"session-1",
			modeRef,
			{
				current: {
					modelId: "gpt-5.5",
					providerId: "openai",
				} satisfies ChatModelSelection,
			},
			{
				load: async () => ({ kind: "api-key", apiKey: "key" }),
				replaceValidated: async () => undefined,
				getStatus: async () => ({
					connected: true,
					providerId: "wincode",
					kind: "api-key",
				}),
			}
		);

		await expect(
			transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [
					{
						id: "msg-1",
						metadata: { mode: "build", model: "bad-model" },
						parts: [{ text: "hi", type: "text" }],
						role: "user",
					},
				] as unknown as Parameters<
					typeof transport.sendMessages
				>[0]["messages"],
				metadata: undefined,
				trigger: "submit-message",
			})
		).rejects.toThrow("Invalid chat model metadata: bad-model");
	});

	test("direct transport throws missing credential error without network", async () => {
		const fetchMock = mock(async () => new Response("network"));
		const originalFetch = globalThis.fetch;
		globalThis.fetch = fetchMock as unknown as typeof fetch;
		try {
			const transport = createLocalChatTransport(
				"session-1",
				modeRef,
				{
					current: {
						modelId: "gpt-5.5",
						providerId: "openai",
					} satisfies ChatModelSelection,
				},
				{
					load: async () => null,
					replaceValidated: async () => undefined,
					getStatus: async () => ({
						connected: false,
						providerId: "openai",
						kind: undefined,
					}),
				}
			);

			await expect(
				transport.sendMessages({
					abortSignal: undefined,
					body: undefined,
					chatId: "session-1",
					headers: undefined,
					messageId: undefined,
					messages: [] as unknown as Parameters<
						typeof transport.sendMessages
					>[0]["messages"],
					metadata: undefined,
					trigger: "submit-message",
				})
			).rejects.toThrow("Connect openai with /connect");
			expect(fetchMock).not.toHaveBeenCalled();
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("direct transport rejects an OpenAI OAuth session without an account ID", async () => {
		const createStream = mock(async () => new ReadableStream());
		const transport = createLocalChatTransport(
			"session-1",
			modeRef,
			{
				current: {
					modelId: "gpt-5.5",
					providerId: "openai",
				} satisfies ChatModelSelection,
			},
			{
				load: async () => ({
					accessToken: "token",
					expiresAt: new Date(Date.now() + 60_000).toISOString(),
					kind: "oauth-session" as const,
					refreshToken: "refresh-token",
					updatedAt: new Date().toISOString(),
				}),
				replaceValidated: async () => undefined,
				getStatus: async () => ({
					connected: true,
					kind: "oauth-session" as const,
					providerId: "openai" as const,
				}),
			},
			createStream
		);

		await expect(
			transport.sendMessages({
				abortSignal: undefined,
				body: undefined,
				chatId: "session-1",
				headers: undefined,
				messageId: undefined,
				messages: [] as unknown as Parameters<
					typeof transport.sendMessages
				>[0]["messages"],
				metadata: undefined,
				trigger: "submit-message",
			})
		).rejects.toThrow(
			"OpenAI account ID missing. Reconnect OpenAI with /connect."
		);
		expect(createStream).not.toHaveBeenCalled();
	});

	test("local transport exposes reconnectToStream null", async () => {
		const transport = createLocalChatTransport(
			"session-1",
			modeRef,
			{
				current: {
					modelId: "gpt-5.5",
					providerId: "openai",
				} satisfies ChatModelSelection,
			},
			{
				load: async () => ({ kind: "api-key", apiKey: "key" }),
				replaceValidated: async () => undefined,
				getStatus: async () => ({
					connected: true,
					providerId: "openai",
					kind: "api-key",
				}),
			}
		);

		expect(
			await transport.reconnectToStream({ chatId: "session-1" })
		).toBeNull();
	});

	test("local transport passes agent stream options", async () => {
		const calls: Record<string, unknown>[] = [];
		const transport = createLocalChatTransport(
			"session-1",
			modeRef,
			{
				current: {
					modelId: "gpt-5.5",
					providerId: "openai",
				} satisfies ChatModelSelection,
			},
			{
				load: async () => ({ kind: "api-key", apiKey: "key" }),
				replaceValidated: async () => undefined,
				getStatus: async () => ({
					connected: true,
					providerId: "openai",
					kind: "api-key",
				}),
			},
			async (options) => {
				calls.push(options as Record<string, unknown>);
				return new ReadableStream({
					start(controller) {
						controller.close();
					},
				});
			}
		);

		await transport.sendMessages({
			abortSignal: undefined,
			body: undefined,
			chatId: "session-1",
			headers: undefined,
			messageId: undefined,
			messages: [] as unknown as Parameters<
				typeof transport.sendMessages
			>[0]["messages"],
			metadata: undefined,
			trigger: "submit-message",
		});

		expect(calls[0]).toMatchObject({
			abortSignal: undefined,
			options: { mode: "build" },
			sendReasoning: true,
		});
	});
});
