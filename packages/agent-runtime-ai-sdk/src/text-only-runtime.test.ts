import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	AgentInvariantError,
	type AgentTurn,
	type AgentTurnEvent,
} from "@wincode/agent-core";
import { createModelTarget } from "@wincode/ai/model-target";
// Keep the process-global Bun module mock complete: test files execute in one
// process and may import unrelated AI SDK exports while this mock is active.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realAi from "ai";

const buildTurn = (): AgentTurn => ({
	agent: {
		displayName: "Build",
		id: "build",
		instructions: "Implement the request.",
		role: "primary",
	},
	id: "turn-1",
	input: {
		messages: [
			{
				id: "msg-user",
				parts: [{ text: "Say hello", type: "text" }],
				role: "user",
			},
		],
	},
	model: createModelTarget(
		{ modelId: "gpt-5.4-mini", providerId: "openai" },
		{ kind: "api-key", apiKey: "test-key" }
	),
});

type MockStreamPart = { type: string } & Record<string, unknown>;

const loadSubject = async (
	parts: MockStreamPart[] = [],
	options?: {
		streamThrows?: Error;
	}
) => {
	const agentSettings: Record<string, unknown>[] = [];
	const streamCalls: Record<string, unknown>[] = [];
	class MockToolLoopAgent {
		readonly settings: Record<string, unknown>;
		constructor(settings: Record<string, unknown>) {
			this.settings = settings;
			agentSettings.push(settings);
		}
		async stream(args: Record<string, unknown>) {
			streamCalls.push(args);
			if (options?.streamThrows) {
				throw options.streamThrows;
			}
			return {
				fullStream: {
					async *[Symbol.asyncIterator]() {
						for (const part of parts) {
							yield part;
						}
					},
				},
			};
		}
	}
	await mock.module("ai", () => ({
		...realAi,
		ToolLoopAgent: MockToolLoopAgent,
	}));
	const subject = await import(
		`./text-only-runtime?test=${crypto.randomUUID()}`
	);
	return { agentSettings, streamCalls, ...subject };
};

const consume = async (events: AgentTurnEvent[]): Promise<AgentTurnEvent[]> => {
	const collected: AgentTurnEvent[] = [];
	for await (const event of events) {
		collected.push(event);
	}
	return collected;
};

afterEach(() => {
	mock.restore();
	mock.clearAllMocks();
});

describe("createAiSdkTextOnlyAgentRuntime", () => {
	test("streams a completed text-only turn through the public runtime interface", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", text: "Hello" },
			{ type: "text-delta", id: "t1", text: " world" },
			{ type: "text-end", id: "t1" },
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 12, outputTokens: 7 },
				finishReason: "stop",
				rawFinishReason: "stop",
				providerMetadata: undefined,
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				totalUsage: { inputTokens: 12, outputTokens: 7 },
			},
		]);
		const {
			agentSettings,
			createAiSdkTextOnlyAgentRuntime: loadRuntime,
			streamCalls,
		} = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(buildTurn()));
		// The adapter composes the Wincode turn into existing AI SDK mechanics:
		// one tool-less Model Step with the Agent instructions as system prompt.
		expect(agentSettings).toHaveLength(1);
		expect(agentSettings[0]).toMatchObject({
			activeTools: [],
			instructions: "Implement the request.",
			// Exactly one Model Step; a drift back to the SDK multi-step default
			// would fail this identity check.
			stopWhen: realAi.stepCountIs(1),
		});
		expect(streamCalls).toHaveLength(1);
		expect(streamCalls[0]?.prompt).toEqual([
			{
				content: [{ text: "Say hello", type: "text" }],
				role: "user",
			},
		]);
		expect(streamCalls[0]?.abortSignal).toBeUndefined();

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"text-delta",
			"text-delta",
			"model-step-finished",
			"agent-turn-completed",
		]);
		expect(events[0]).toMatchObject({
			sequence: 0,
			turnId: "turn-1",
			type: "agent-turn-started",
		});
		// Monotonic sequences across the whole turn.
		const sequences = events.map(({ sequence }) => sequence);
		expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
		expect(new Set(sequences).size).toBe(sequences.length);
		// Text deltas coalesce into one committed assistant text.
		const text = events
			.filter(
				(event): event is Extract<AgentTurnEvent, { type: "text-delta" }> =>
					event.type === "text-delta"
			)
			.map(({ delta }) => delta)
			.join("");
		expect(text).toBe("Hello world");
		// Usage normalized onto step and turn completion.
		const completed = events.find(
			({ type }) => type === "agent-turn-completed"
		);
		expect(completed).toMatchObject({
			usage: { inputTokens: 12, outputTokens: 7 },
		});
	});

	test("maps a stream error to a failed terminal event", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{ type: "error", error: new Error("rate limited") },
		]);
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(buildTurn()));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"agent-turn-failed",
		]);
		const failed = events.at(-1);
		expect(failed?.type).toBe("agent-turn-failed");
		if (failed?.type === "agent-turn-failed") {
			expect(failed.failure).toMatchObject({
				source: "model",
				version: 1,
			});
			// Normalized through the safe failure taxonomy, not raw text.
			expect(failed.failure.message).not.toContain("rate limited");
		}
	});

	test("stops cleanly when the caller aborts the run", async () => {
		let released: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			released = resolve;
		});
		await mock.module("ai", () => {
			class MockToolLoopAgent {
				readonly settings: Record<string, unknown>;
				constructor(settings: Record<string, unknown>) {
					this.settings = settings;
				}
				async stream() {
					return {
						fullStream: {
							async *[Symbol.asyncIterator]() {
								yield { type: "start-step", request: {}, warnings: [] };
								await gate;
								yield { type: "text-delta", id: "t1", text: "late" };
							},
						},
					};
				}
			}
			return { ...realAi, ToolLoopAgent: MockToolLoopAgent };
		});
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = await import(
			`./text-only-runtime?test=${crypto.randomUUID()}`
		);
		const runtime = loadRuntime();
		const controller = new AbortController();
		const collected: string[] = [];
		const consumption = (async () => {
			for await (const event of runtime.run(buildTurn(), {
				signal: controller.signal,
			})) {
				collected.push(event.type);
			}
		})();
		await new Promise((resolve) => setTimeout(resolve, 0));
		controller.abort();
		released?.();
		await consumption;

		// A caller cancellation is a terminal cancelled outcome, not a
		// fabricated completion and not a silently truncated stream.
		expect(collected).toEqual([
			"agent-turn-started",
			"model-step-started",
			"agent-turn-cancelled",
		]);
	});
	test("maps deadline expiry to a distinct failed outcome", async () => {
		const subject = await loadSubject([]);
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const signal = AbortSignal.abort(
			new DOMException("deadline expired", "TimeoutError")
		);

		const events = await consume(runtime.run(buildTurn(), { signal }));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"agent-turn-failed",
		]);
		const failed = events.at(-1);
		expect(failed?.type).toBe("agent-turn-failed");
		if (failed?.type === "agent-turn-failed") {
			expect(failed.failure).toMatchObject({
				code: "deadline-exceeded",
				source: "runtime",
				version: 1,
			});
			expect(failed.failure.message).not.toContain("deadline expired");
		}
	});

	test("marks a provider stream that ends without a terminal as interrupted", async () => {
		const subject = await loadSubject([]);
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();

		const events = await consume(runtime.run(buildTurn()));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"agent-turn-interrupted",
		]);
		const interrupted = events.at(-1);
		expect(interrupted?.type).toBe("agent-turn-interrupted");
		if (interrupted?.type === "agent-turn-interrupted") {
			expect(interrupted).toMatchObject({
				failure: {
					code: "interrupted",
					retry: "immediate",
					source: "runtime",
				},
				reason: "lost-execution",
			});
		}
	});
	test("throws a typed invariant with a cause when model resolution breaks", async () => {
		const subject = await loadSubject([]);
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime({
			resolveModel: () => {
				throw new Error("private model construction detail");
			},
		});
		let thrown: unknown;
		try {
			await consume(runtime.run(buildTurn()));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(AgentInvariantError);
		if (thrown instanceof AgentInvariantError) {
			expect(thrown.code).toBe("invalid-runtime");
			expect(thrown.cause).toBeInstanceOf(Error);
		}
	});

	test("emits a failed terminal for an internal SDK abort the caller did not cause", async () => {
		// The caller never aborted, yet the SDK stopped with an AbortError
		// (provider or step-controller initiated). Swallowing it would end the
		// run with no terminal event, violating the exactly-one-terminal
		// contract and silently truncating the UI reply.
		const abortError = new Error("The stream was aborted.");
		abortError.name = "AbortError";
		const subject = await loadSubject([], { streamThrows: abortError });
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(buildTurn()));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"agent-turn-failed",
		]);
		const failed = events.at(-1);
		expect(failed?.type).toBe("agent-turn-failed");
		if (failed?.type === "agent-turn-failed") {
			expect(failed.failure.code).toBe("cancelled");
			// Cancellation is turn-machinery behavior, not a model verdict:
			// the failure carries the runtime source, never the model's.
			expect(failed.failure.source).toBe("runtime");
			expect(failed.failure.version).toBe(1);
			expect(failed.failure.message).not.toContain("aborted");
		}
	});

	test("attributes an abort-shaped error part to the runtime, not the model", async () => {
		const abortError = new Error("cancelled by provider");
		abortError.name = "AbortError";
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{ type: "error", error: abortError },
		]);
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(buildTurn()));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"agent-turn-failed",
		]);
		const failed = events.at(-1);
		expect(failed?.type).toBe("agent-turn-failed");
		if (failed?.type === "agent-turn-failed") {
			expect(failed.failure).toMatchObject({
				code: "cancelled",
				retry: "never",
				source: "runtime",
				version: 1,
			});
			expect(failed.failure.message).not.toContain("provider");
		}
	});

	test("maps a thrown provider error to a failed terminal event", async () => {
		const subject = await loadSubject([], {
			streamThrows: new Error("connection reset"),
		});
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(buildTurn()));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"agent-turn-failed",
		]);
		const failed = events.at(-1);
		expect(failed?.type).toBe("agent-turn-failed");
		if (failed?.type === "agent-turn-failed") {
			expect(failed.failure).toMatchObject({
				source: "model",
				version: 1,
			});
			expect(failed.failure.message.length).toBeGreaterThan(0);
		}
	});

	test("classifies rate-limited SDK errors instead of leaking raw text", async () => {
		const error = new Error("API returned 429: rate limit exceeded");
		Object.assign(error, { statusCode: 429, name: "AI_APICallError" });
		const subject = await loadSubject([], { streamThrows: error });
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(buildTurn()));

		const failed = events.at(-1);
		expect(failed?.type).toBe("agent-turn-failed");
		if (failed?.type === "agent-turn-failed") {
			expect(failed.failure.code).toBe("rate-limited");
			// Presentation-safe: the raw provider body never crosses.
			expect(failed.failure.message).not.toContain("429");
		}
	});

	test("yields only Wincode event shapes through the public stream", async () => {
		const subject = await loadSubject([]);
		const { createAiSdkTextOnlyAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const stream = runtime.run(buildTurn());
		for await (const event of stream) {
			// Compile-time: AgentTurnEvent union fields only.
			expect(typeof event.turnId).toBe("string");
			expect(event.type).toBe("agent-turn-started");
			break;
		}
	});
});
