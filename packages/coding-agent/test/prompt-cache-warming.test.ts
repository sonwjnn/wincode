import { afterEach, describe, expect, test, vi } from "bun:test";
import type {
	ModelPromptMessage,
	ModelStepRequest,
} from "@wincode/ai/model-client";
import { createModelTarget } from "@wincode/ai/model-target";
import type { ChatRequest } from "@wincode/ai/sdk";
import {
	computeCacheWarmDelayMs,
	createSessionCacheWarming,
	expectedCacheWarmSavingsUsd,
} from "@/modules/prompt-cache/cache-warming";
import type {
	CreateSessionUsageEntryInput,
	SessionUsageEntry,
} from "@/modules/sessions/storage/session-store";
import { modelId, sessionId } from "./support/identifiers";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.useRealTimers();
});

const createWarmRequest = (
	prompt = "current prompt"
): { messages: ModelPromptMessage[]; request: ModelStepRequest } => {
	const messages = [
		{
			content: [{ text: prompt, type: "text" as const }],
			role: "user" as const,
		},
	];
	const target = createModelTarget(
		{ modelId: modelId("gpt-5.6"), providerId: "openai" },
		{ apiKey: "test-key", kind: "api-key" },
		{
			maxOutputTokens: 100,
			promptCacheEnabled: true,
			promptCacheRetention: "short",
			thinkingLevel: "high",
		}
	);
	return {
		messages,
		request: {
			messages,
			promptCacheKey: "wincode-session:test",
			system: "stable instructions",
			target,
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

const createWarming = (store: {
	createSessionUsageEntry: (
		input: CreateSessionUsageEntryInput
	) => Promise<SessionUsageEntry>;
}) =>
	createSessionCacheWarming({
		getPricingTable: () => ({
			"openai/gpt-5.6": {
				cost: { cacheRead: 0.4, input: 4, output: 20 },
			},
		}),
		initialUsageEntries: [],
		sessionId: sessionId("cache-warm-test"),
		store,
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
			max_output_tokens: 1,
			prompt_cache_key: "wincode-session:test",
			prompt_cache_options: { mode: "explicit", ttl: "30m" },
			reasoning: { summary: "detailed" },
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
		expect(warming.getUsageEntries()).toEqual(entries);
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

	test("an SDK Model Step cancels legacy warm work without a ModelClient replay", async () => {
		vi.useFakeTimers();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			throw new Error("SDK turns must not replay through ModelClient.");
		}) as unknown as typeof fetch;
		const { entries, store } = createEntryWriter();
		const warming = createWarming(store);
		const legacyRequest = createWarmRequest().request;
		warming.modelStepObserver.onModelStepStarted(legacyRequest);
		warming.modelStepObserver.onModelStepFinished(legacyRequest, measuredUsage);
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

	test("an SDK Model Step aborts an in-flight legacy warmer", async () => {
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

	test("isolates failed warm requests and unsafe or Google replays", async () => {
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

		const google = createModelTarget(
			{ modelId: modelId("gemini-3.8-flash"), providerId: "google" },
			{ apiKey: "test-key", kind: "api-key" },
			{ promptCacheEnabled: true, promptCacheRetention: "short" }
		);
		const googleRequest: ModelStepRequest = {
			googleCachedContent: { name: "cachedContents/resource" },
			messages: [],
			target: google,
		};
		warming.modelStepObserver.onModelStepStarted(googleRequest);
		warming.modelStepObserver.onModelStepFinished(googleRequest, measuredUsage);
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
			}
		);

		// One hit saves $0.162; the warm replay costs $0.03801.
		expect(savings).toBeCloseTo(0.123_99, 9);
		expect(savings).toBeGreaterThanOrEqual(0.05);
	});

	test("enforces the minimum five-cent savings threshold", () => {
		const pricing = { cost: { cacheRead: 0.4, input: 4, output: 20 } };
		const belowThreshold = expectedCacheWarmSavingsUsd(pricing, {
			cacheReadTokens: 62_000,
			inputTokens: 100_000,
			outputTokens: 100,
		});
		const aboveThreshold = expectedCacheWarmSavingsUsd(pricing, {
			cacheReadTokens: 63_000,
			inputTokens: 100_000,
			outputTokens: 100,
		});

		expect(belowThreshold).toBeLessThan(0.05);
		expect(aboveThreshold).toBeGreaterThanOrEqual(0.05);
	});

	test("keeps expected savings unknown when cache-read pricing is unpublished", () => {
		expect(
			expectedCacheWarmSavingsUsd(
				{ cost: { input: 10, output: 10 } },
				{ cacheReadTokens: 10_000, inputTokens: 20_000, outputTokens: 80 }
			)
		).toBeNull();
	});

	test("skips usage without a known non-zero cache breakdown", () => {
		expect(
			expectedCacheWarmSavingsUsd(
				{ cost: { cacheRead: 1, input: 10, output: 10 } },
				{ inputTokens: 20_000, outputTokens: 80 }
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
				}
			)
		).toBeNull();
	});
});
