import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type ChatMessage,
	type ChatRequest,
	createOpenAIProvider,
	createProviderCollection,
	type Provider,
	type ProviderCollection,
	type ProviderModel,
} from "@wincode/ai";
import {
	computeCacheWarmDelayMs,
	createSessionCacheWarming,
	expectedCacheWarmSavingsUsd,
} from "@/modules/prompt-cache/cache-warming";
import type {
	CreateSessionUsageEntryInput,
	SessionUsageEntry,
	SessionWriteOutcome,
} from "@/modules/sessions/storage/session-store";
import { createSessionUsageLedger } from "@/modules/sessions/usage/session-usage-ledger";
import { sessionId } from "./support/identifiers";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.useRealTimers();
});

const createWarmRequest = (
	prompt = "current prompt"
): { messages: ChatMessage[]; request: ChatRequest } => {
	const messages: ChatMessage[] = [
		{
			content: [{ text: prompt, type: "text" }],
			role: "user",
		},
	];
	return {
		messages,
		request: {
			cacheRetention: "short",
			maxOutputTokens: 100,
			messages,
			modelId: "gpt-5.6",
			promptCacheKey: "wincode-session:test",
			providerId: "openai",
			reasoningEffort: "high",
			system: "stable instructions",
		},
	};
};

const measuredUsage = {
	cacheReadTokens: 90_000,
	inputTokens: 100_000,
	outputTokens: 100,
};

const flushPromises = async (): Promise<void> => {
	for (let index = 0; index < 10; index += 1) {
		await Promise.resolve();
	}
};

const createEntryWriter = (): {
	entries: SessionUsageEntry[];
	store: {
		createSessionUsageEntry: (
			input: CreateSessionUsageEntryInput
		) => Promise<SessionUsageEntry>;
	};
} => {
	const entries: SessionUsageEntry[] = [];
	return {
		entries,
		store: {
			createSessionUsageEntry: async (input) => {
				const entry = { ...input, createdAt: input.createdAt ?? new Date() };
				entries.push(entry);
				return entry;
			},
		},
	};
};

const createDefaultProviderCollection = (): ProviderCollection => {
	const collection = createProviderCollection({
		credentialStore: {
			delete: () => undefined,
			list: () => [{ providerId: "openai", type: "api-key" }],
			modify: async (_providerId, update) =>
				update({ apiKey: "test-key", kind: "api-key" }),
			read: () => ({ apiKey: "test-key", kind: "api-key" }),
		},
		modelStore: { get: () => undefined, set: () => undefined },
	});
	const model: ProviderModel = {
		modelId: "gpt-5.6",
		pricing: {
			cacheReadPerMillionTokensUsd: 0.4,
			inputPerMillionTokensUsd: 4,
			outputPerMillionTokensUsd: 20,
		},
		promptCache: {
			explicit: { retentionTiers: ["short"] },
			protocols: {
				"openai-responses": {
					breakpoints: true,
					eligibility: { minimumInputTokens: 1 },
					promptCacheKey: true,
					retention: {
						field: "prompt_cache_options.ttl",
						values: { short: "30m" },
					},
				},
			},
		},
		promptCacheRetentionTiers: ["short"],
		promptCacheRetentionTtlMs: { short: 30 * 60_000 },
		protocolId: "openai-responses",
		providerId: "openai",
	};
	collection.register(createOpenAIProvider({ models: [model] }));
	return collection;
};

const createWarming = (
	store: {
		createSessionUsageEntry: (
			input: CreateSessionUsageEntryInput
		) => Promise<SessionUsageEntry>;
	},
	providerCollection: ProviderCollection = createDefaultProviderCollection()
) =>
	createSessionCacheWarming({
		providerCollection,
		usageLedger: createSessionUsageLedger({
			initialEntries: [],
			sessionId: sessionId("cache-warm-test"),
			store: {
				createSessionUsageEntry: async (input) => ({
					entry: await store.createSessionUsageEntry(input),
					writeOutcome: {
						entryHash: "0".repeat(64),
						kind: "committed",
						operationId: `usage-${input.id}`,
						projection: "ready",
						sequence: 0,
					} satisfies SessionWriteOutcome,
				}),
			},
		}),
	});

describe("Session Cache Warming", () => {
	test("replays the captured prompt at 90% TTL and persists only warm usage", async () => {
		vi.useFakeTimers();
		let calls = 0;
		let body: Record<string, unknown> | undefined;
		globalThis.fetch = (async (
			_input: Request | string | URL,
			init?: RequestInit
		) => {
			calls += 1;
			body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			return new Response(
				[
					'event: response.output_text.delta\ndata: {"delta":"discarded warm output"}\n\n',
					'event: response.completed\ndata: {"response":{"usage":{"input_tokens":100000,"output_tokens":1,"input_tokens_details":{"cached_tokens":90000}}}}\n\n',
				].join(""),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const { messages, request } = createWarmRequest();
		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		expect(warming.getStatus()).toBe("scheduled");
		vi.advanceTimersByTime(27 * 60_000 - 1);
		expect(calls).toBe(0);
		messages.push({
			content: [
				{ text: "new context is not part of this replay", type: "text" },
			],
			role: "assistant",
		});
		vi.advanceTimersByTime(1);
		await flushPromises();

		expect(calls).toBe(1);
		expect(body).toMatchObject({
			input: [
				{
					content: [
						{
							prompt_cache_breakpoint: { mode: "explicit" },
							text: "stable instructions",
							type: "input_text",
						},
					],
					role: "developer",
					type: "message",
				},
				{
					content: [{ text: "current prompt", type: "input_text" }],
					role: "user",
					type: "message",
				},
			],
			max_output_tokens: 1,
			model: "gpt-5.6",
			prompt_cache_key: "wincode-session:test",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			stream: true,
		});
		expect(JSON.stringify(body)).toContain("current prompt");
		expect(JSON.stringify(body)).toContain("stable instructions");
		expect(JSON.stringify(body)).not.toContain(
			"new context is not part of this replay"
		);
		expect(JSON.stringify(entries)).not.toContain("discarded warm output");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "cache-warm",
			model: { modelId: "gpt-5.6", providerId: "openai" },
			usage: { cacheReadTokens: 90_000, inputTokens: 100_000, outputTokens: 1 },
		});
		expect(warming.getStatus()).toBe("scheduled");
		await warming.dispose();
	});

	test("repeats successful refreshes until the one-hour horizon and counts each warm once", async () => {
		vi.useFakeTimers();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(
				[
					'event: response.completed\ndata: {"response":{"usage":{"input_tokens":100000,"output_tokens":1,"input_tokens_details":{"cached_tokens":90000}}}}\n\n',
				].join(""),
				{ headers: { "content-type": "text/event-stream" } }
			);
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const request = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();
		expect(calls).toBe(1);
		expect(entries).toHaveLength(1);
		expect(warming.getStatus()).toBe("scheduled");

		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();
		expect(calls).toBe(2);
		expect(entries).toHaveLength(2);
		expect(new Set(entries.map(({ id }) => id)).size).toBe(2);
		expect(
			entries.every(
				({ kind, usage }) => kind === "cache-warm" && usage.outputTokens === 1
			)
		).toBe(true);
		expect(warming.getStatus()).toBe("idle");

		vi.advanceTimersByTime(6 * 60_000);
		await flushPromises();
		expect(calls).toBe(2);
		expect(entries).toHaveLength(2);
		await warming.dispose();
	});

	test("stops refreshing when warm usage no longer clears the savings threshold", async () => {
		vi.useFakeTimers();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			return new Response(
				'event: response.completed\ndata: {"response":{"usage":{"input_tokens":100000,"output_tokens":1,"input_tokens_details":{"cached_tokens":62000}}}}\n\n',
				{ headers: { "content-type": "text/event-stream" } }
			);
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const request = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();
		expect(calls).toBe(1);
		expect(entries).toHaveLength(1);
		expect(warming.getStatus()).toBe("idle");

		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();
		expect(calls).toBe(1);
		expect(entries).toHaveLength(1);
		await warming.dispose();
	});

	test("a new SDK Provider request cancels scheduled warm work before replay", async () => {
		vi.useFakeTimers();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("A cancelled SDK warm request must not dispatch.");
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const warmRequest = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(warmRequest);
		warming.modelStepObserver.onModelStepFinished(warmRequest, measuredUsage);
		expect(warming.getStatus()).toBe("scheduled");

		const sdkRequest: ChatRequest = {
			messages: [
				{
					content: [{ text: "SDK prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			promptCacheKey: "wincode-session:test",
			providerId: "openai",
		};
		warming.modelStepObserver.onModelStepStarted(sdkRequest);
		expect(warming.getStatus()).toBe("idle");
		warming.modelStepObserver.onModelStepFinished(sdkRequest, measuredUsage);
		expect(warming.getStatus()).toBe("idle");

		vi.advanceTimersByTime(60 * 60_000);
		await flushPromises();
		expect(calls).toBe(0);
		expect(entries).toEqual([]);
		await warming.dispose();
	});

	test("SDK cache warmth replays through ProviderCollection and accounts only successful usage", async () => {
		vi.useFakeTimers();
		const bodies: Record<string, unknown>[] = [];
		const collection = createProviderCollection();
		collection.register(
			createOpenAIProvider({
				fetch: async (_input, init) => {
					bodies.push(
						JSON.parse(String(init?.body)) as Record<string, unknown>
					);
					return new Response(
						'event: response.completed\ndata: {"response":{"output":[],"usage":{"input_tokens":100000,"output_tokens":1,"input_tokens_details":{"cached_tokens":90000}}}}\n\n',
						{ headers: { "content-type": "text/event-stream" } }
					);
				},
			})
		);
		await collection.setCredential("openai", {
			apiKey: "sdk-warm-test-key",
			kind: "api-key",
		});
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			maxOutputTokens: 500,
			messages: [
				{
					content: [{ text: "captured SDK prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			promptCacheKey: "wincode-session:sdk-test",
			providerId: "openai",
			reasoningEffort: "high",
			system: "SDK stable instructions",
		};
		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		expect(warming.getStatus()).toBe("scheduled");
		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();

		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			max_output_tokens: 1,
			model: "gpt-5.6",
			prompt_cache_key: "wincode-session:sdk-test",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
		});
		expect(bodies[0]).not.toHaveProperty("reasoning");
		expect(JSON.stringify(bodies[0])).toContain("captured SDK prompt");
		expect(JSON.stringify(bodies[0])).toContain("SDK stable instructions");
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "cache-warm",
			model: { modelId: "gpt-5.6", providerId: "openai" },
			usage: { cacheReadTokens: 90_000, inputTokens: 100_000, outputTokens: 1 },
		});
		expect(warming.getStatus()).toBe("scheduled");
		await warming.dispose();
		await collection.close();
	});

	test("Provider Model cache metadata enables warming without a pricing-table source", async () => {
		vi.useFakeTimers();
		const collection = createProviderCollection();
		collection.register(
			createOpenAIProvider({ fetch: async () => new Response() })
		);
		const { store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			messages: [
				{
					content: [{ text: "priced SDK prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			providerId: "openai",
		};

		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		expect(warming.getStatus()).toBe("scheduled");
		await warming.dispose();
		await collection.close();
	});

	test("SDK-declared Provider Models warm from exact model metadata", async () => {
		vi.useFakeTimers();
		let authorizationCalls = 0;
		let streamCalls = 0;
		let receivedOutputTokenCap: number | undefined;
		const collection = createProviderCollection();
		const provider: Provider = {
			id: "private-provider",
			models: [
				{
					modelId: "private-only-cache-model",
					pricing: {
						cacheReadPerMillionTokensUsd: 0.4,
						inputPerMillionTokensUsd: 4,
						outputPerMillionTokensUsd: 20,
					},
					promptCacheRetentionTiers: ["short"],
					promptCacheRetentionTtlMs: { short: 30 * 60_000 },
					protocolId: "fixture",
					providerId: "private-provider",
				},
			],
			resolveAuthorization: () => {
				authorizationCalls += 1;
				return { authorization: "fixture-only" };
			},
			async *streamChat(request) {
				streamCalls += 1;
				receivedOutputTokenCap = request.maxOutputTokens;
				yield {
					type: "usage",
					usage: {
						cacheReadTokens: 90_000,
						inputTokens: 100_000,
						outputTokens: 1,
					},
				};
				yield { type: "finish" };
			},
		};
		collection.register(provider);
		await collection.setCredential("private-provider", {
			fixtureCredential: true,
		});
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			messages: [
				{
					content: [{ text: "SDK-only captured prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "private-only-cache-model",
			providerId: "private-provider",
		};

		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);
		expect(warming.getStatus()).toBe("scheduled");
		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();

		expect(authorizationCalls).toBe(1);
		expect(streamCalls).toBe(1);
		expect(receivedOutputTokenCap).toBe(1);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			kind: "cache-warm",
			model: {
				modelId: "private-only-cache-model",
				providerId: "private-provider",
			},
		});
		await warming.dispose();
		await collection.close();
	});

	test("SDK warming skips OpenAI OAuth before resolving authorization or dispatching a warm request", async () => {
		vi.useFakeTimers();
		let fetchCalls = 0;
		let authorizationCalls = 0;
		let streamCalls = 0;
		const model = {
			modelId: "oauth-cache-model",
			pricing: {
				cacheReadPerMillionTokensUsd: 0.4,
				inputPerMillionTokensUsd: 4,
				outputPerMillionTokensUsd: 20,
			},
			promptCacheRetentionTiers: ["short"] as const,
			promptCacheRetentionTtlMs: { short: 30 * 60_000 },
			protocolId: "openai-responses",
			providerId: "openai",
		};
		const openAIProvider = createOpenAIProvider({
			fetch: async () => {
				fetchCalls += 1;
				return new Response();
			},
			models: [model],
		});
		const provider: Provider = {
			...openAIProvider,
			resolveAuthorization: (input) => {
				authorizationCalls += 1;
				return openAIProvider.resolveAuthorization(input);
			},
			streamChat: (request, context) => {
				streamCalls += 1;
				return openAIProvider.streamChat(request, context);
			},
		};
		const collection = createProviderCollection();
		collection.register(provider);
		await collection.setCredential("openai", {
			accessToken: "fixture-oauth-token",
			accountId: "fixture-oauth-account",
			expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
			kind: "oauth-session",
			refreshToken: "fixture-oauth-refresh-token",
			updatedAt: new Date().toISOString(),
		});
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			messages: [
				{
					content: [{ text: "OAuth prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "oauth-cache-model",
			providerId: "openai",
		};

		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);
		expect(warming.getStatus()).toBe("scheduled");
		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();

		expect(authorizationCalls).toBe(0);
		expect(streamCalls).toBe(0);
		expect(fetchCalls).toBe(0);
		expect(entries).toEqual([]);
		expect(warming.getStatus()).toBe("idle");
		await warming.dispose();
		await collection.close();
	});

	test("SDK warming skips Provider Models missing exact cache tiers or TTL metadata", async () => {
		const collection = createProviderCollection();
		collection.register(
			createOpenAIProvider({
				fetch: async () => new Response(),
				models: [
					{
						modelId: "gpt-5.6",
						pricing: {
							cacheReadPerMillionTokensUsd: 0.4,
							inputPerMillionTokensUsd: 4,
							outputPerMillionTokensUsd: 20,
						},
						promptCacheRetentionTiers: ["long"],
						promptCacheRetentionTtlMs: { long: 24 * 60 * 60_000 },
						protocolId: "openai-responses",
						providerId: "openai",
					},
				],
			})
		);
		const { store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			messages: [
				{
					content: [{ text: "unsupported retention prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			providerId: "openai",
		};

		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		expect(warming.getStatus()).toBe("idle");
		await warming.dispose();
		await collection.close();
	});

	test("SDK warming skips Provider Models with no TTL for an advertised cache tier", async () => {
		const collection = createProviderCollection();
		collection.register(
			createOpenAIProvider({
				fetch: async () => new Response(),
				models: [
					{
						modelId: "gpt-5.6",
						pricing: {
							cacheReadPerMillionTokensUsd: 0.4,
							inputPerMillionTokensUsd: 4,
							outputPerMillionTokensUsd: 20,
						},
						promptCacheRetentionTiers: ["short"],
						protocolId: "openai-responses",
						providerId: "openai",
					},
				],
			})
		);
		const { store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			messages: [
				{
					content: [{ text: "missing TTL prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			providerId: "openai",
		};

		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		expect(warming.getStatus()).toBe("idle");
		await warming.dispose();
		await collection.close();
	});

	test("SDK warming skips a Provider Model whose exact price metadata is unknown", async () => {
		const collection = createProviderCollection();
		collection.register(
			createOpenAIProvider({
				fetch: async () => new Response(),
				models: [
					{
						modelId: "gpt-5.6",
						promptCacheRetentionTiers: ["short"],
						promptCacheRetentionTtlMs: { short: 30 * 60_000 },
						protocolId: "openai-responses",
						providerId: "openai",
					},
				],
			})
		);
		const { store } = createEntryWriter();
		const warming = createWarming(store, collection);
		const request: ChatRequest = {
			cacheRetention: "short",
			messages: [
				{
					content: [{ text: "unpriced SDK prompt", type: "text" }],
					role: "user",
				},
			],
			modelId: "gpt-5.6",
			providerId: "openai",
		};

		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);

		expect(warming.getStatus()).toBe("idle");
		await warming.dispose();
		await collection.close();
	});

	test("a newer real request replaces the scheduled warmer and cancellation prevents refresh", async () => {
		vi.useFakeTimers();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("the canceled warmer must not call the provider");
		}) as unknown as typeof fetch;
		const { store } = createEntryWriter();
		const warming = createWarming(store);
		const first = createWarmRequest("first prompt").request;
		warming.modelStepObserver.onModelStepStarted(first);
		warming.modelStepObserver.onModelStepFinished(first, measuredUsage);
		expect(warming.getStatus()).toBe("scheduled");

		const second = createWarmRequest("replacement prompt").request;
		warming.modelStepObserver.onModelStepStarted(second);
		expect(warming.getStatus()).toBe("idle");
		warming.modelStepObserver.onModelStepFinished(second, measuredUsage);
		expect(warming.getStatus()).toBe("scheduled");
		warming.cancel();
		expect(warming.getStatus()).toBe("idle");
		vi.advanceTimersByTime(60 * 60_000);
		expect(calls).toBe(0);
		await warming.dispose();
	});

	test("a new SDK Provider request aborts an in-flight warm request", async () => {
		vi.useFakeTimers();
		let fetchSignal: AbortSignal | undefined;
		const response = Promise.withResolvers<Response>();
		globalThis.fetch = ((
			_input: Request | string | URL,
			init?: RequestInit
		) => {
			const signal = init?.signal;
			if (signal === null || signal === undefined) {
				response.reject(new Error("the warm request must be abortable"));
				return response.promise;
			}
			fetchSignal = signal;
			signal.addEventListener("abort", () => response.reject(signal.reason), {
				once: true,
			});
			return response.promise;
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const request = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(request);
		warming.modelStepObserver.onModelStepFinished(request, measuredUsage);
		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();
		expect(warming.getStatus()).toBe("warming");
		expect(fetchSignal?.aborted).toBe(false);

		const sdkRequest: ChatRequest = {
			messages: [],
			modelId: "gpt-5.6",
			providerId: "openai",
		};
		warming.modelStepObserver.onModelStepStarted(sdkRequest);
		warming.modelStepObserver.onModelStepFinished(sdkRequest, measuredUsage);
		await flushPromises();
		expect(fetchSignal?.aborted).toBe(true);
		expect(warming.getStatus()).toBe("idle");
		expect(entries).toEqual([]);
		await warming.dispose();
	});

	test("isolates failed warm requests and unsafe SDK replays", async () => {
		vi.useFakeTimers();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("network unavailable");
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const { request: unsafeRequest } = createWarmRequest();
		const unsafe = {
			...unsafeRequest,
			messages: [
				{
					content: [
						{
							input: () => "not cloneable",
							toolCallId: "call-unsafe",
							toolName: "lookup",
							type: "tool-call" as const,
						},
					],
					role: "assistant" as const,
				},
			],
		};
		warming.modelStepObserver.onModelStepStarted(unsafe);
		warming.modelStepObserver.onModelStepFinished(unsafe, measuredUsage);
		expect(warming.getStatus()).toBe("idle");

		const belowSavingsThreshold = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(belowSavingsThreshold);
		warming.modelStepObserver.onModelStepFinished(belowSavingsThreshold, {
			cacheReadTokens: 62_000,
			inputTokens: 100_000,
			outputTokens: 100,
		});
		expect(warming.getStatus()).toBe("idle");

		const normal = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(normal);
		warming.modelStepObserver.onModelStepFinished(normal, measuredUsage);
		expect(warming.getStatus()).toBe("scheduled");
		vi.advanceTimersByTime(27 * 60_000);
		await flushPromises();
		expect(calls).toBe(1);
		expect(entries).toEqual([]);
		expect(warming.getStatus()).toBe("idle");
		await warming.dispose();
	});
});

describe("computeCacheWarmDelayMs", () => {
	test("schedules at 90% of a supported TTL while preserving the margin", () => {
		expect(computeCacheWarmDelayMs(5 * 60_000)).toBe(270_000);
		expect(computeCacheWarmDelayMs(30 * 60_000)).toBe(27 * 60_000);
		expect(computeCacheWarmDelayMs(60 * 60_000)).toBe(54 * 60_000);
		expect(60 * 60_000 - (computeCacheWarmDelayMs(60 * 60_000) ?? 0)).toBe(
			6 * 60_000
		);
	});

	test("skips short TTLs and lifetimes whose 90% point exceeds the one-hour horizon", () => {
		expect(computeCacheWarmDelayMs(10_000)).toBeNull();
		expect(computeCacheWarmDelayMs(2 * 60 * 60_000)).toBeNull();
	});
});

describe("expectedCacheWarmSavingsUsd", () => {
	test("requires one conservatively priced future hit to repay the warm replay", () => {
		const savings = expectedCacheWarmSavingsUsd(
			{ cost: { cacheRead: 1, input: 10, output: 10 } },
			{
				cacheReadTokens: 18_000,
				cacheWriteTokens: 0,
				inputTokens: 20_000,
				outputTokens: 80,
			},
			1
		);

		// One hit saves $0.162; the one-token warm replay costs $0.03801.
		expect(savings).toBeCloseTo(0.123_99, 9);
		expect(savings).toBeGreaterThanOrEqual(0.05);
	});

	test("prices the actual warm response usage instead of assuming one output token", () => {
		const pricing = { cost: { cacheRead: 1, input: 10, output: 10_000 } };
		const usage = {
			cacheReadTokens: 90_000,
			inputTokens: 100_000,
			outputTokens: 0,
		};

		const enforcedOneTokenCap = expectedCacheWarmSavingsUsd(pricing, usage, 1);
		const actualWarmResponse = expectedCacheWarmSavingsUsd(pricing, usage, 100);

		expect(enforcedOneTokenCap).toBeGreaterThan(0.05);
		expect(actualWarmResponse).toBeLessThan(0);
	});

	test("enforces the minimum five-cent savings threshold", () => {
		const pricing = { cost: { cacheRead: 0.4, input: 4, output: 20 } };
		const belowThreshold = expectedCacheWarmSavingsUsd(
			pricing,
			{
				cacheReadTokens: 62_000,
				inputTokens: 100_000,
				outputTokens: 100,
			},
			1
		);
		const aboveThreshold = expectedCacheWarmSavingsUsd(
			pricing,
			{
				cacheReadTokens: 63_000,
				inputTokens: 100_000,
				outputTokens: 100,
			},
			1
		);

		expect(belowThreshold).toBeLessThan(0.05);
		expect(aboveThreshold).toBeGreaterThanOrEqual(0.05);
	});

	test("keeps expected savings unknown when cache-read pricing is unpublished", () => {
		expect(
			expectedCacheWarmSavingsUsd(
				{ cost: { input: 10, output: 10 } },
				{ cacheReadTokens: 10_000, inputTokens: 20_000, outputTokens: 80 },
				1
			)
		).toBeNull();
	});

	test("skips usage without a known non-zero cache breakdown", () => {
		expect(
			expectedCacheWarmSavingsUsd(
				{ cost: { cacheRead: 1, input: 10, output: 10 } },
				{ inputTokens: 20_000, outputTokens: 80 },
				1
			)
		).toBeNull();
	});

	test("rejects cache breakdowns that exceed total input rather than inflating savings", () => {
		expect(
			expectedCacheWarmSavingsUsd(
				{ cost: { cacheRead: 1, input: 10, output: 10 } },
				{
					cacheReadTokens: 15_000,
					cacheWriteTokens: 10_000,
					inputTokens: 20_000,
					outputTokens: 80,
				},
				1
			)
		).toBeNull();
	});
});
