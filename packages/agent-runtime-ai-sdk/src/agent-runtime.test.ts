import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	AgentInvariantError,
	type AgentTurn,
	type AgentTurnEvent,
	type ResolvedTool,
	type ToolDefinition,
} from "@wincode/agent-core";
import { createModelTarget } from "@wincode/ai/model-target";
// Keep the process-global Bun module mock complete: test files execute in one
// process and may import unrelated AI SDK exports while this mock is active.
// biome-ignore lint/performance/noNamespaceImport: mock spread needs the full namespace
import * as realAi from "ai";
import { z } from "zod";

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

const readDefinition = {
	description: "Read a UTF-8 text file.",
	inputSchema: z.object({ path: z.string() }),
	name: "read",
	outputSchema: z.object({ content: z.string(), path: z.string() }),
} satisfies ToolDefinition;

const resolvedReadTool = (execute: ResolvedTool["execute"]): ResolvedTool => ({
	definition: readDefinition,
	execute,
});

const toolArmedTurn = (
	tools: readonly ResolvedTool[] = [
		resolvedReadTool(async () => ({
			output: { content: "file content", path: "src/x.ts" },
			type: "success",
		})),
	],
	messages: AgentTurn["input"]["messages"] = [
		{
			id: "msg-user",
			parts: [{ text: "Say hello", type: "text" }],
			role: "user",
		},
	]
): AgentTurn => ({ ...buildTurn(), input: { messages }, tools });

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
	const subject = await import(`./agent-runtime?test=${crypto.randomUUID()}`);
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

describe("createAiSdkAgentRuntime", () => {
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
			createAiSdkAgentRuntime: loadRuntime,
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

	test("passes provider-neutral file parts to the AI SDK prompt", async () => {
		const imageData = "data:image/png;base64,AA==";
		const subject = await loadSubject();
		const turn: AgentTurn = {
			...buildTurn(),
			input: {
				messages: [
					{
						id: "message-image",
						parts: [
							{ text: "Inspect this image", type: "text" },
							{
								data: imageData,
								mediaType: "image/png",
								type: "file",
							},
						],
						role: "user",
					},
				],
			},
		};
		const { createAiSdkAgentRuntime: loadRuntime, streamCalls } = subject;

		await consume(loadRuntime().run(turn));

		expect(streamCalls[0]?.prompt).toEqual([
			{
				content: [
					{ text: "Inspect this image", type: "text" },
					{ data: imageData, mediaType: "image/png", type: "file" },
				],
				role: "user",
			},
		]);
	});

	test("maps a stream error to a failed terminal event", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{ type: "error", error: new Error("rate limited") },
		]);
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = await import(
			`./agent-runtime?test=${crypto.randomUUID()}`
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
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

describe("createAiSdkAgentRuntime tool-armed turns", () => {
	test("declares gated tools and runs multiple Model Steps", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{
				type: "tool-input-start",
				id: "call-1",
				toolName: "read",
			},
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/x.ts" },
			},
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/x.ts" },
				output: { content: "file content", path: "src/x.ts" },
			},
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 5, outputTokens: 2 },
				finishReason: "tool-calls",
				rawFinishReason: "tool-calls",
				providerMetadata: undefined,
			},
			{ type: "start-step", request: {}, warnings: [] },
			{ type: "text-start", id: "t1" },
			{ type: "text-delta", id: "t1", text: "Done" },
			{ type: "text-end", id: "t1" },
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 3, outputTokens: 1 },
				finishReason: "stop",
				rawFinishReason: "stop",
				providerMetadata: undefined,
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				totalUsage: { inputTokens: 8, outputTokens: 3 },
			},
		]);
		const { agentSettings, createAiSdkAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(toolArmedTurn()));

		expect(agentSettings[0]).toMatchObject({
			activeTools: ["read"],
			stopWhen: realAi.stepCountIs(20),
		});
		const sdkTools = agentSettings[0]?.tools as Record<string, unknown>;
		expect(Object.keys(sdkTools)).toEqual(["read"]);
		const readTool = sdkTools.read as {
			description?: unknown;
			execute?: unknown;
			inputSchema?: unknown;
		};
		expect(readTool.description).toBe(readDefinition.description);
		expect(readTool.inputSchema).toBe(readDefinition.inputSchema);
		expect(typeof readTool.execute).toBe("function");

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"tool-call-started",
			"tool-call-finished",
			"model-step-finished",
			"model-step-started",
			"text-delta",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const started = events.find(({ type }) => type === "tool-call-started");
		expect(started).toMatchObject({
			input: { path: "src/x.ts" },
			toolCallId: "call-1",
			toolName: "read",
		});
		const finished = events.find(({ type }) => type === "tool-call-finished");
		expect(finished).toMatchObject({
			outcome: {
				output: { content: "file content", path: "src/x.ts" },
				type: "success",
			},
			toolCallId: "call-1",
		});
		const completed = events.at(-1);
		expect(completed).toMatchObject({
			usage: { inputTokens: 8, outputTokens: 3 },
		});
	});

	test("runs the resolved executor through the SDK execute boundary", async () => {
		const calls: unknown[] = [];
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/x.ts" },
			},
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/x.ts" },
				output: { content: "c", path: "src/x.ts" },
			},
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "tool-calls",
				rawFinishReason: "tool-calls",
				providerMetadata: undefined,
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				totalUsage: { inputTokens: 1, outputTokens: 1 },
			},
		]);
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const turn = toolArmedTurn([
			resolvedReadTool(async (request, options) => {
				calls.push({ options, request });
				return {
					output: { content: "c", path: "src/x.ts" },
					type: "success",
				};
			}),
		]);
		const events = await consume(runtime.run(turn));
		expect(events.some(({ type }) => type === "agent-turn-completed")).toBe(
			true
		);

		// The SDK execute boundary receives the model input plus identity and
		// passes the runtime abort signal through.
		const sdkTools = (
			subject.agentSettings[0]?.tools as Record<string, unknown>
		).read as {
			execute: (
				input: unknown,
				options: Record<string, unknown>
			) => Promise<unknown>;
		};
		expect(typeof sdkTools.execute).toBe("function");
		const outcome = await sdkTools.execute(
			{ path: "src/x.ts" },
			{ toolCallId: "call-9", abortSignal: undefined }
		);
		expect(outcome).toEqual({ content: "c", path: "src/x.ts" });
		expect(calls).toEqual([
			{
				options: { signal: undefined },
				request: {
					input: { path: "src/x.ts" },
					toolCallId: "call-9",
				},
			},
		]);
	});

	test("turns a failed executor outcome into an SDK tool error with the safe text", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "read",
				input: { path: "src/x.ts" },
			},
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "tool-calls",
				rawFinishReason: "tool-calls",
				providerMetadata: undefined,
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				totalUsage: { inputTokens: 1, outputTokens: 1 },
			},
		]);
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const turn = toolArmedTurn([
			resolvedReadTool(async () => ({
				errorText: "Read denied by policy: src/x.ts",
				type: "failure",
			})),
		]);
		await consume(runtime.run(turn));

		const sdkTools = (
			subject.agentSettings[0]?.tools as Record<string, unknown>
		).read as {
			execute: (
				input: unknown,
				options: Record<string, unknown>
			) => Promise<unknown>;
		};
		let thrown: unknown;
		try {
			await sdkTools.execute({ path: "x" }, { toolCallId: "call-2" });
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		if (thrown instanceof Error) {
			expect(thrown.message).toBe("Read denied by policy: src/x.ts");
		}
	});

	test("maps tool results and tool errors to correlated finished events", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{
				type: "tool-call",
				toolCallId: "call-1",
				toolName: "glob",
				input: { pattern: "**/*.ts" },
			},
			{
				type: "tool-result",
				toolCallId: "call-1",
				toolName: "glob",
				input: { pattern: "**/*.ts" },
				output: { paths: ["a.ts"] },
			},
			{
				type: "tool-call",
				toolCallId: "call-2",
				toolName: "grep",
				input: { pattern: "foo" },
			},
			{
				type: "tool-error",
				toolCallId: "call-2",
				toolName: "grep",
				input: { pattern: "foo" },
				error: new Error("Grep denied by policy: foo"),
			},
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "tool-calls",
				rawFinishReason: "tool-calls",
				providerMetadata: undefined,
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				totalUsage: { inputTokens: 1, outputTokens: 1 },
			},
		]);
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const turn = toolArmedTurn([
			resolvedReadTool(async () => ({ output: {}, type: "success" })),
		]);
		const events = await consume(runtime.run(turn));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"tool-call-started",
			"tool-call-finished",
			"tool-call-started",
			"tool-call-finished",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const failures = events.filter(({ type }) => type === "tool-call-finished");
		expect(failures[1]).toMatchObject({
			outcome: {
				errorText: "Grep denied by policy: foo",
				type: "failure",
			},
			toolCallId: "call-2",
			toolName: "grep",
		});
	});

	test("synthesizes a started event for a lone tool error", async () => {
		const subject = await loadSubject([
			{ type: "start-step", request: {}, warnings: [] },
			{
				type: "tool-error",
				toolCallId: "call-1",
				toolName: "read",
				input: undefined,
				error: new Error("Tool call input was invalid."),
			},
			{
				type: "finish-step",
				response: {},
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "tool-calls",
				rawFinishReason: "tool-calls",
				providerMetadata: undefined,
			},
			{
				type: "finish",
				finishReason: "stop",
				rawFinishReason: "stop",
				totalUsage: { inputTokens: 1, outputTokens: 1 },
			},
		]);
		const { createAiSdkAgentRuntime: loadRuntime } = subject;
		const runtime = loadRuntime();
		const events = await consume(runtime.run(toolArmedTurn()));

		expect(events.map(({ type }) => type)).toEqual([
			"agent-turn-started",
			"model-step-started",
			"tool-call-started",
			"tool-call-finished",
			"model-step-finished",
			"agent-turn-completed",
		]);
		const started = events.find(({ type }) => type === "tool-call-started");
		expect(started).toMatchObject({
			toolCallId: "call-1",
			toolName: "read",
		});
		const finished = events.find(({ type }) => type === "tool-call-finished");
		expect(finished).toMatchObject({
			outcome: { errorText: "Tool call input was invalid.", type: "failure" },
		});
	});

	test("converts tool history into SDK model messages", async () => {
		const subject = await loadSubject([]);
		const { createAiSdkAgentRuntime: loadRuntime, streamCalls } = subject;
		const runtime = loadRuntime();
		const turn = toolArmedTurn(
			[resolvedReadTool(async () => ({ output: {}, type: "success" }))],
			[
				{
					id: "msg-user",
					parts: [{ text: "Read it", type: "text" }],
					role: "user",
				},
				{
					id: "msg-assistant",
					parts: [
						{ text: "Reading", type: "text" },
						{
							input: { path: "a.ts" },
							toolCallId: "call-1",
							toolName: "read",
							type: "tool-call",
						},
					],
					role: "assistant",
				},
				{
					id: "msg-tool-1",
					parts: [
						{
							output: { content: "c", path: "a.ts" },
							toolCallId: "call-1",
							toolName: "read",
							type: "tool-result",
						},
					],
					role: "tool",
				},
				{
					id: "msg-tool-2",
					parts: [
						{
							errorText: "Grep denied by policy: x",
							toolCallId: "call-2",
							toolName: "grep",
							type: "tool-failure",
						},
					],
					role: "tool",
				},
			]
		);
		await consume(runtime.run(turn));

		expect(streamCalls[0]?.prompt).toEqual([
			{ content: [{ text: "Read it", type: "text" }], role: "user" },
			{
				content: [
					{ text: "Reading", type: "text" },
					{
						input: { path: "a.ts" },
						toolCallId: "call-1",
						toolName: "read",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
			{
				content: [
					{
						output: { type: "json", value: { content: "c", path: "a.ts" } },
						toolCallId: "call-1",
						toolName: "read",
						type: "tool-result",
					},
				],
				role: "tool",
			},
			{
				content: [
					{
						output: {
							type: "error-text",
							value: "Grep denied by policy: x",
						},
						toolCallId: "call-2",
						toolName: "grep",
						type: "tool-result",
					},
				],
				role: "tool",
			},
		]);
	});
});
