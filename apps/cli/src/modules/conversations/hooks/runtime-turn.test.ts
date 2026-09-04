import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentRuntime,
	type AgentTurn,
	type AgentTurnEvent,
	type ConversationMessageRecord,
	type ConversationRecord,
	type ConversationToolCallPart,
	createAgentTurnAbortReason,
	type OperationalFailure,
} from "@wincode/agent-core";
import type {
	CodingAgentUIMessage,
	ResolvedAgentRuntime,
	ToolResourceLimits,
} from "@wincode/ai";
import { createModelTarget } from "@wincode/ai/model-target";
import type { UIMessageChunk } from "ai";
import type { GateOutcome, ToolGate } from "@/modules/tool-gate/tool-gate";
import { createDatabase } from "../storage/client";
import type { ConversationStore } from "../storage/conversation-store";
import { createDrizzleConversationStore } from "../storage/drizzle-conversation-store";
import { runMigrations } from "../storage/migrations";
import {
	buildAgentTurn,
	createGatedCodingTools,
	createRuntimeStream,
	isRuntimeEligibleSend,
	type MigratedToolCallPart,
} from "./runtime-turn";

const agent: ResolvedAgentRuntime = {
	instructions: "Answer plainly.",
	visibleCodingTools: [],
};

const userMessage = (text: string): CodingAgentUIMessage =>
	({
		id: "msg-user",
		parts: [{ text, type: "text" }],
		role: "user",
	}) as CodingAgentUIMessage;

const textMessage = (
	role: "assistant" | "user",
	text: string
): CodingAgentUIMessage =>
	({
		id: `msg-${role}`,
		parts: [{ text, type: "text" }],
		role,
	}) as CodingAgentUIMessage;

const modelTarget = createModelTarget(
	{ modelId: "gpt-5.4-mini", providerId: "openai" },
	{ kind: "api-key", apiKey: "test-key" }
);

const assistantMessage = (parts: unknown[]): CodingAgentUIMessage =>
	({ id: "msg-assistant", parts, role: "assistant" }) as CodingAgentUIMessage;

/** A completed migrated tool part as the executor UI would hold it. */
const outputToolPart = (
	toolCallId: string,
	extra?: Partial<Record<string, unknown>>
): MigratedToolCallPart =>
	({
		output: { text: "file contents" },
		state: "output-available",
		toolCallId,
		toolName: "read",
		type: "tool-read",
		...extra,
	}) as unknown as MigratedToolCallPart;

const failedToolPart = (
	toolCallId: string,
	errorText = "File not found"
): MigratedToolCallPart =>
	({
		errorText,
		state: "output-error",
		toolCallId,
		toolName: "read",
		type: "tool-read",
	}) as unknown as MigratedToolCallPart;

const allowGate: ToolGate = {
	gate: async () => ({ kind: "allow" }),
};

const eligibilityArgs = (
	messages: readonly CodingAgentUIMessage[],
	resolvedAgent: ResolvedAgentRuntime | undefined = agent,
	gate?: ToolGate
) => ({
	gate,
	mcpManifest: [],
	messages,
	resolvedAgent,
	skill: undefined,
	skillTool: undefined,
});

describe("isRuntimeEligibleSend", () => {
	test("accepts a pure text conversation for a tool-less Agent", () => {
		expect(isRuntimeEligibleSend(eligibilityArgs([userMessage("hello")]))).toBe(
			true
		);
	});

	test("requires the Tool Gate and accepts migrated coding tools", () => {
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs(
					[userMessage("hello")],
					{ instructions: "x", visibleCodingTools: ["read"] },
					allowGate
				)
			)
		).toBe(true);
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs(
					[userMessage("hello")],
					{ instructions: "x", visibleCodingTools: ["glob", "grep"] },
					allowGate
				)
			)
		).toBe(true);
		// A tool-armed Agent without the Gate has no runtime route: the send
		// must keep the legacy loop instead of running tool-less.
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs([userMessage("hello")], {
					instructions: "x",
					visibleCodingTools: ["read"],
				})
			)
		).toBe(false);
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs(
					[userMessage("hello")],
					{ instructions: "x", visibleCodingTools: ["write"] },
					allowGate
				)
			)
		).toBe(true);
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs(
					[userMessage("hello")],
					{ instructions: "x", visibleCodingTools: ["read", "shell"] },
					allowGate
				)
			)
		).toBe(true);
	});

	test("rejects MCP tools and Skill activation", () => {
		const base = {
			messages: [userMessage("hello")],
			resolvedAgent: agent,
		};
		expect(
			isRuntimeEligibleSend({
				...base,
				mcpManifest: [
					{ description: "mcp tool", inputSchema: {}, name: "mcp-tool" },
				],
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
		expect(
			isRuntimeEligibleSend({
				...base,
				mcpManifest: [],
				skill: undefined,
				skillTool: {
					description: "x",
					inputSchema: {
						additionalProperties: false,
						properties: { name: { type: "string" } },
						required: ["name"],
						type: "object",
					},
					name: "skill",
				},
			})
		).toBe(false);
	});

	test("accepts terminal migrated tool parts in history and rejects in-flight ones", () => {
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs([
					userMessage("x"),
					assistantMessage([outputToolPart("call-1")]),
				])
			)
		).toBe(true);
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs([
					userMessage("x"),
					assistantMessage([failedToolPart("call-2")]),
				])
			)
		).toBe(true);
		const inFlight = assistantMessage([
			{ toolCallId: "call-3", type: "tool-read", state: "input-available" },
		]);
		expect(
			isRuntimeEligibleSend(eligibilityArgs([userMessage("x"), inFlight]))
		).toBe(false);
	});

	test("rejects empty-error migrated parts, non-assistant tool history, and file parts", () => {
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs([
					userMessage("x"),
					assistantMessage([failedToolPart("call-1", "")]),
				])
			)
		).toBe(false);
		const toolUser = {
			id: "msg-tool-user",
			parts: [outputToolPart("call-2")],
			role: "user",
		} as unknown as CodingAgentUIMessage;
		expect(
			isRuntimeEligibleSend(eligibilityArgs([userMessage("x"), toolUser]))
		).toBe(false);
		const withFilePart = {
			id: "msg-file",
			parts: [{ type: "file", url: "file:///x" }],
			role: "user",
		} as unknown as CodingAgentUIMessage;
		expect(isRuntimeEligibleSend(eligibilityArgs([withFilePart]))).toBe(false);
	});

	test("accepts text-only interrupted history for a fresh retry turn", () => {
		const interrupted = {
			id: "msg-assistant",
			metadata: { interrupted: true },
			parts: [{ text: "partial", type: "text" }],
			role: "assistant",
		} as unknown as CodingAgentUIMessage;
		expect(
			isRuntimeEligibleSend(eligibilityArgs([userMessage("x"), interrupted]))
		).toBe(true);
	});

	test("rejects a reasoning-only assistant reply in history", () => {
		const reasoningOnly = {
			id: "msg-assistant",
			parts: [
				{ type: "step-start" },
				{ id: "reasoning-1", text: "thinking", type: "reasoning" },
			],
			role: "assistant",
		} as unknown as CodingAgentUIMessage;
		expect(
			isRuntimeEligibleSend(
				eligibilityArgs([userMessage("x"), reasoningOnly, userMessage("y")])
			)
		).toBe(false);
	});

	test("rejects a missing resolved Agent", () => {
		expect(
			isRuntimeEligibleSend({
				gate: allowGate,
				mcpManifest: [],
				messages: [userMessage("x")],
				resolvedAgent: undefined,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
	});
});

describe("buildAgentTurn", () => {
	test("composes instructions and strips UI-only parts", () => {
		const turn = buildAgentTurn({
			agent: "build",
			modelMessages: [
				textMessage("user", "hello"),
				{
					...textMessage("assistant", "hi"),
					parts: [{ type: "step-start" }, { text: "hi", type: "text" }],
				} as CodingAgentUIMessage,
			],
			modelTarget,
			resolvedAgent: agent,
			turnId: "turn-1",
		});

		expect(turn.id).toBe("turn-1");
		expect(turn.agent.id).toBe("build");
		expect(turn.agent.instructions).toContain("Answer plainly.");
		expect(turn.model).toBe(modelTarget);
		expect(turn.input.messages).toHaveLength(2);
		expect(turn.input.messages[0]).toEqual({
			id: "msg-user",
			parts: [{ text: "hello", type: "text" }],
			role: "user",
		});
		expect(turn.tools).toEqual([]);
	});

	test("maps terminal migrated tool history into tool-call and tool result messages", () => {
		const turn = buildAgentTurn({
			agent: "build",
			modelMessages: [
				userMessage("read the file"),
				assistantMessage([
					{ text: "reading…", type: "text" },
					outputToolPart("call-1"),
					failedToolPart("call-2"),
				]),
			],
			modelTarget,
			resolvedAgent: {
				instructions: "x",
				visibleCodingTools: ["read", "glob", "grep"],
			},
			turnId: "turn-1",
		});

		expect(turn.input.messages).toEqual([
			{
				id: "msg-user",
				parts: [{ text: "read the file", type: "text" }],
				role: "user",
			},
			{
				id: "msg-assistant",
				parts: [
					{ text: "reading…", type: "text" },
					{
						input: undefined,
						toolCallId: "call-1",
						toolName: "read",
						type: "tool-call",
					},
					{
						input: undefined,
						toolCallId: "call-2",
						toolName: "read",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
			{
				id: "tool-call-1",
				parts: [
					{
						output: { text: "file contents" },
						toolCallId: "call-1",
						toolName: "read",
						type: "tool-result",
					},
				],
				role: "tool",
			},
			{
				id: "tool-call-2",
				parts: [
					{
						errorText: "File not found",
						toolCallId: "call-2",
						toolName: "read",
						type: "tool-failure",
					},
				],
				role: "tool",
			},
		]);
	});
});

describe("createRuntimeStream", () => {
	const runtimeWith = (events: AgentTurnEvent[]): AgentRuntime => ({
		run: (turn: AgentTurn) => {
			expect(turn.id).toBe("turn-1");
			return {
				async *[Symbol.asyncIterator]() {
					for (const event of events) {
						yield event;
					}
				},
			};
		},
	});

	const buildTurn = () =>
		buildAgentTurn({
			agent: "build",
			modelMessages: [userMessage("hello")],
			modelTarget,
			resolvedAgent: agent,
			turnId: "turn-1",
		});

	const consume = async (
		stream: ReadableStream<UIMessageChunk>
	): Promise<UIMessageChunk[]> => {
		const chunks: UIMessageChunk[] = [];
		const reader = stream.getReader();
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			chunks.push(value);
		}
		return chunks;
	};

	const startedEvent = (sequence: number): AgentTurnEvent => ({
		agentId: "build",
		sequence,
		startedAt: sequence,
		turnId: "turn-1",
		type: "agent-turn-started",
	});
	const completedEvent = (
		sequence: number,
		usage?: { inputTokens: number; outputTokens: number }
	): AgentTurnEvent => ({
		finishedAt: sequence,
		sequence,
		turnId: "turn-1",
		type: "agent-turn-completed",
		...(usage === undefined ? {} : { usage }),
	});
	const failedEvent = (
		sequence: number,
		failure: {
			code: OperationalFailure["code"];
			message: string;
			retry: OperationalFailure["retry"];
			source: OperationalFailure["source"];
		}
	): AgentTurnEvent => ({
		failure: { ...failure, version: 1 },
		finishedAt: sequence,
		sequence,
		turnId: "turn-1",
		type: "agent-turn-failed",
	});

	test("maps a completed turn to the executor display chunk protocol", async () => {
		const stream = await createRuntimeStream({
			runtime: runtimeWith([
				startedEvent(0),
				{
					modelId: "gpt-5.4-mini",
					sequence: 1,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-started",
				},
				{ delta: "Hel", sequence: 2, turnId: "turn-1", type: "text-delta" },
				{ delta: "lo", sequence: 3, turnId: "turn-1", type: "text-delta" },
				{
					sequence: 4,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
					usage: { inputTokens: 3, outputTokens: 2 },
				},
				completedEvent(5, { inputTokens: 3, outputTokens: 2 }),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ type: "start-step" },
			{ id: "text-1", type: "text-start" },
			{ delta: "Hel", id: "text-1", type: "text-delta" },
			{ delta: "lo", id: "text-1", type: "text-delta" },
			{ id: "text-1", type: "text-end" },
			{ type: "finish-step" },
			{
				finishReason: "stop",
				messageMetadata: { usage: { inputTokens: 3, outputTokens: 2 } },
				type: "finish",
			},
		]);
	});

	test("maps a failed turn to an error chunk and closes", async () => {
		const stream = await createRuntimeStream({
			runtime: runtimeWith([
				startedEvent(0),
				failedEvent(1, {
					code: "unknown",
					message: "provider blew up",
					retry: "never",
					source: "model",
				}),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ errorText: "The model request failed.", type: "error" },
		]);
	});

	test("sanitizes failure messages before presentation and persistence", async () => {
		const checkpoints: ConversationRecord[] = [];
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				startedEvent(0),
				failedEvent(1, {
					code: "unknown",
					message: "provider response contains secret-token",
					retry: "never",
					source: "model",
				}),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);

		expect(JSON.stringify(chunks)).not.toContain("secret-token");
		expect(JSON.stringify(checkpoints)).not.toContain("secret-token");
		expect(chunks).toEqual([
			{ errorText: "The model request failed.", type: "error" },
		]);
	});

	test("streams reasoning deltas before text with open/close parts", async () => {
		const stream = await createRuntimeStream({
			runtime: runtimeWith([
				startedEvent(0),
				{
					modelId: "gpt-5.4-mini",
					sequence: 1,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-started",
				},
				{
					delta: "think",
					sequence: 2,
					turnId: "turn-1",
					type: "reasoning-delta",
				},
				{ delta: "hi", sequence: 3, turnId: "turn-1", type: "text-delta" },
				{
					sequence: 4,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
				},
				completedEvent(5),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ type: "start-step" },
			{ id: "reasoning-1", type: "reasoning-start" },
			{ delta: "think", id: "reasoning-1", type: "reasoning-delta" },
			{ id: "text-1", type: "text-start" },
			{ delta: "hi", id: "text-1", type: "text-delta" },
			{ id: "text-1", type: "text-end" },
			{ id: "reasoning-1", type: "reasoning-end" },
			{ type: "finish-step" },
			{ finishReason: "stop", type: "finish" },
		]);
	});

	test("emits tool input and output chunks with unique text parts per model step", async () => {
		const stream = await createRuntimeStream({
			runtime: runtimeWith([
				startedEvent(0),
				{
					modelId: "gpt-5.4-mini",
					sequence: 1,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-started",
				},
				{ delta: "Hel", sequence: 2, turnId: "turn-1", type: "text-delta" },
				{
					input: { path: "a.ts" },
					sequence: 3,
					toolCallId: "call-1",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-started",
				},
				{
					outcome: { output: { text: "file contents" }, type: "success" },
					sequence: 4,
					toolCallId: "call-1",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-finished",
				},
				{
					sequence: 5,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
				},
				{
					modelId: "gpt-5.4-mini",
					sequence: 6,
					stepId: "step-2",
					turnId: "turn-1",
					type: "model-step-started",
				},
				{ delta: "lo", sequence: 7, turnId: "turn-1", type: "text-delta" },
				{
					sequence: 8,
					stepId: "step-2",
					turnId: "turn-1",
					type: "model-step-finished",
				},
				completedEvent(9),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ type: "start-step" },
			{ id: "text-1", type: "text-start" },
			{ delta: "Hel", id: "text-1", type: "text-delta" },
			{
				providerExecuted: true,
				toolCallId: "call-1",
				toolName: "read",
				type: "tool-input-start",
			},
			{
				input: { path: "a.ts" },
				providerExecuted: true,
				toolCallId: "call-1",
				toolName: "read",
				type: "tool-input-available",
			},
			{
				output: { text: "file contents" },
				toolCallId: "call-1",
				type: "tool-output-available",
			},
			{ id: "text-1", type: "text-end" },
			{ type: "finish-step" },
			{ type: "start-step" },
			{ id: "text-2", type: "text-start" },
			{ delta: "lo", id: "text-2", type: "text-delta" },
			{ id: "text-2", type: "text-end" },
			{ type: "finish-step" },
			{ finishReason: "stop", type: "finish" },
		]);
	});

	test("commits one semantic checkpoint with assembled text, Tool Calls, and usage", async () => {
		const checkpoints: ConversationRecord[] = [];
		const log: string[] = [];
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				log.push("checkpoint");
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				startedEvent(0),
				{
					modelId: "gpt-5.4-mini",
					sequence: 1,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-started",
				},
				{ delta: "Hel", sequence: 2, turnId: "turn-1", type: "text-delta" },
				{
					input: { path: "a.ts" },
					sequence: 3,
					toolCallId: "call-1",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-started",
				},
				{
					outcome: { output: { text: "file contents" }, type: "success" },
					sequence: 4,
					toolCallId: "call-1",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-finished",
				},
				{
					sequence: 5,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
				},
				completedEvent(6, { inputTokens: 3, outputTokens: 2 }),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ type: "start-step" },
			{ id: "text-1", type: "text-start" },
			{ delta: "Hel", id: "text-1", type: "text-delta" },
			{
				providerExecuted: true,
				toolCallId: "call-1",
				toolName: "read",
				type: "tool-input-start",
			},
			{
				input: { path: "a.ts" },
				providerExecuted: true,
				toolCallId: "call-1",
				toolName: "read",
				type: "tool-input-available",
			},
			{
				output: { text: "file contents" },
				toolCallId: "call-1",
				type: "tool-output-available",
			},
			{ id: "text-1", type: "text-end" },
			{ type: "finish-step" },
			{
				finishReason: "stop",
				messageMetadata: { usage: { inputTokens: 3, outputTokens: 2 } },
				type: "finish",
			},
		]);
		expect(checkpoints).toHaveLength(1);
		const record = checkpoints[0];
		expect(record).toMatchObject({
			agentId: "build",
			model: { modelId: "gpt-5.4-mini", providerId: "openai" },
			outcome: {
				finishedAt: 6,
				kind: "completed",
				usage: { inputTokens: 3, outputTokens: 2 },
			},
			turnId: "turn-1",
			version: 1,
		});
		const expectedToolPart: ConversationToolCallPart = {
			input: { path: "a.ts" },
			outcome: { kind: "success", output: { text: "file contents" } },
			sequence: 4,
			toolCallId: "call-1",
			toolName: "read",
			type: "tool-call",
		};
		expect(record?.messages).toEqual([
			{
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
			{
				id: "assistant-turn-1",
				parts: [{ text: "Hel", type: "text" }, expectedToolPart],
				role: "assistant",
			},
		]);
		// The checkpoint is durable before the terminal display chunk: text
		// deltas and tool chunks are the only chunks that precede it.
		const chunkTypes = chunks.map((chunk) => chunk.type);
		expect(log.indexOf("checkpoint")).toBeLessThan(
			chunkTypes.indexOf("finish")
		);
	});

	test("maps a failed Tool Call into an output-error chunk and a failure part", async () => {
		const checkpoints: ConversationRecord[] = [];
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				startedEvent(0),
				{
					input: { path: "a.ts" },
					sequence: 1,
					toolCallId: "call-1",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-started",
				},
				{
					outcome: { errorText: "File not found", type: "failure" },
					sequence: 2,
					toolCallId: "call-1",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-finished",
				},
				completedEvent(3),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{
				providerExecuted: true,
				toolCallId: "call-1",
				toolName: "read",
				type: "tool-input-start",
			},
			{
				input: { path: "a.ts" },
				providerExecuted: true,
				toolCallId: "call-1",
				toolName: "read",
				type: "tool-input-available",
			},
			{
				errorText: "File not found",
				toolCallId: "call-1",
				type: "tool-output-error",
			},
			{ finishReason: "stop", type: "finish" },
		]);
		expect(checkpoints[0]?.messages).toEqual([
			{
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
			{
				id: "assistant-turn-1",
				parts: [
					{
						input: { path: "a.ts" },
						outcome: { errorText: "File not found", kind: "failure" },
						sequence: 2,
						toolCallId: "call-1",
						toolName: "read",
						type: "tool-call",
					},
				],
				role: "assistant",
			},
		]);
	});

	test("commits a failed turn with its committed input messages", async () => {
		const checkpoints: ConversationRecord[] = [];
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				startedEvent(0),
				{ delta: "partial", sequence: 1, turnId: "turn-1", type: "text-delta" },
				failedEvent(2, {
					code: "unknown",
					message: "provider blew up",
					retry: "never",
					source: "model",
				}),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ id: "text-1", type: "text-start" },
			{ delta: "partial", id: "text-1", type: "text-delta" },
			{ id: "text-1", type: "text-end" },
			{ errorText: "The model request failed.", type: "error" },
		]);
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]).toMatchObject({
			outcome: {
				failure: {
					code: "unknown",
					message: "The model request failed.",
					retry: "never",
					source: "model",
					version: 1,
				},
				finishedAt: 2,
				kind: "failed",
			},
			turnId: "turn-1",
		});
		// Partial streamed text is not committed; only the resolved input is.
		expect(checkpoints[0]?.messages).toEqual([
			{
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
		]);
	});

	test("commits an interrupted outcome when execution ends without a terminal", async () => {
		const checkpoints: ConversationRecord[] = [];
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				startedEvent(0),
				{ delta: "cut", sequence: 1, turnId: "turn-1", type: "text-delta" },
			]),
			signal: new AbortController().signal,
			turn: buildTurn(),
		});

		const chunks = await consume(stream);

		expect(chunks).toEqual([
			{ id: "text-1", type: "text-start" },
			{ delta: "cut", id: "text-1", type: "text-delta" },
			{ id: "text-1", type: "text-end" },
			{
				errorText: "The Agent Turn was interrupted.",
				type: "error",
			},
		]);
		expect(checkpoints).toHaveLength(1);
		expect(checkpoints[0]?.outcome).toMatchObject({
			failure: {
				code: "interrupted",
				retry: "immediate",
				source: "runtime",
			},
			kind: "interrupted",
			reason: "lost-execution",
		});
	});

	test("commits a distinct cancelled outcome and stops late runtime output", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		const checkpoints: ConversationRecord[] = [];
		const runtime: AgentRuntime = {
			run: () => ({
				async *[Symbol.asyncIterator]() {
					started.resolve();
					yield startedEvent(0);
					await gate;
					yield {
						delta: "late",
						sequence: 1,
						turnId: "turn-1",
						type: "text-delta" as const,
					};
				},
			}),
		};
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime,
			signal: controller.signal,
			turn: buildTurn(),
		});
		const consumption = consume(stream);
		await started.promise;
		controller.abort(createAgentTurnAbortReason("cancelled"));
		release?.();

		const chunks = await consumption;

		expect(chunks).toEqual([
			{
				errorText: "The Agent Turn was cancelled.",
				type: "error",
			},
		]);
		expect(checkpoints[0]?.outcome).toMatchObject({
			failure: {
				code: "cancelled",
				retry: "never",
				source: "runtime",
			},
			kind: "cancelled",
		});
	});

	test("commits an explicit user interruption as a new terminal outcome", async () => {
		const controller = new AbortController();
		const checkpoints: ConversationRecord[] = [];
		const runtime = runtimeWith([startedEvent(0)]);
		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime,
			signal: controller.signal,
			turn: buildTurn(),
		});
		const consumption = consume(stream);
		controller.abort(createAgentTurnAbortReason("interrupted"));

		const chunks = await consumption;

		expect(chunks).toEqual([
			{
				errorText: "The Agent Turn was interrupted.",
				type: "error",
			},
		]);
		expect(checkpoints[0]?.outcome).toMatchObject({
			failure: {
				code: "interrupted",
				retry: "immediate",
				source: "runtime",
			},
			kind: "interrupted",
			reason: "user",
		});
	});

	test("surfaces a checkpoint failure without emitting a finish chunk", async () => {
		const stream = await createRuntimeStream({
			onCheckpoint: async () => {
				throw new Error("disk full");
			},
			runtime: runtimeWith([startedEvent(0), completedEvent(1)]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{
				errorText: "The Agent Turn outcome could not be persisted.",
				type: "error",
			},
		]);
	});

	test("keeps the real failure text when a failed turn checkpoint fails", async () => {
		const stream = await createRuntimeStream({
			onCheckpoint: async () => {
				throw new Error("disk full");
			},
			runtime: runtimeWith([
				startedEvent(0),
				failedEvent(1, {
					code: "rate-limited",
					message: "slow down",
					retry: "after-delay",
					source: "model",
				}),
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{
				errorText: "The model provider rate-limited the request.",
				type: "error",
			},
		]);
	});
});

describe("createGatedCodingTools", () => {
	const stubGate = (outcome: unknown): ToolGate =>
		({ gate: async () => outcome }) as unknown as ToolGate;

	const workspaceDir = () => mkdtemp(join(process.cwd(), ".wincode-gated-"));

	test("resolves one gated Resolved Tool per migrated coding family", () => {
		const tools = createGatedCodingTools({
			agentTools: ["read", "glob", "write", "shell"],
			gate: stubGate({ kind: "allow" }),
		});
		expect(tools.map((tool) => tool.definition.name)).toEqual([
			"read",
			"glob",
			"write",
			"shell",
		]);
	});

	test("routes shell execution through the shell gate and public runner", async () => {
		const calls: unknown[] = [];
		const tools = createGatedCodingTools({
			agentTools: ["shell"],
			gate: {
				gate: async (call) => {
					calls.push(call);
					return { kind: "allow" };
				},
			},
		});
		expect(tools[0]?.definition.description).toContain("/bin/bash -c");
		const outcome = await tools[0]?.execute({
			input: { command: "printf migrated-shell" },
			toolCallId: "shell-call",
		});
		expect(calls).toEqual([
			{
				family: "coding",
				toolCall: {
					input: { command: "printf migrated-shell" },
					toolCallId: "shell-call",
					toolName: "shell",
				},
			},
		]);
		expect(outcome).toEqual({
			output: { exitCode: 0, output: "migrated-shell" },
			type: "success",
		});
	});

	test("runs an allowed Tool Call through the public runner", async () => {
		const dir = await workspaceDir();
		try {
			const target = join(dir, "notes.txt");
			await writeFile(target, "gated contents");
			const tools = createGatedCodingTools({
				agentTools: ["read"],
				gate: stubGate({ kind: "allow" }),
			});
			const outcome = await tools[0]?.execute({
				input: { path: target },
				toolCallId: "call-1",
			});
			expect(outcome).toEqual({
				output: { content: "1:gated contents", path: target },
				type: "success",
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	test("evaluates the actual resource and executes it instead of the request", async () => {
		const dir = await workspaceDir();
		try {
			const requested = join(dir, "requested.txt");
			const actual = join(dir, "actual.txt");
			await writeFile(requested, "requested contents");
			await writeFile(actual, "actual contents");
			const tools = createGatedCodingTools({
				agentTools: ["read"],
				gate: stubGate({ kind: "allow", input: { path: actual } }),
			});
			const outcome = await tools[0]?.execute({
				input: { path: requested },
				toolCallId: "call-1",
			});
			expect(outcome).toEqual({
				output: { content: "1:actual contents", path: actual },
				type: "success",
			});
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});

	test("maps deny and rejection outcomes to a failure errorText without running", async () => {
		const tools = createGatedCodingTools({
			agentTools: ["read"],
			gate: stubGate({ errorText: "Path not allowed", kind: "deny" }),
		});
		const outcome = await tools[0]?.execute({
			input: { path: "any.ts" },
			toolCallId: "call-1",
		});
		expect(outcome).toEqual({
			errorText: "Path not allowed",
			type: "failure",
		});
	});

	test("falls back to a stable errorText when the gate denies without text", async () => {
		const tools = createGatedCodingTools({
			agentTools: ["read"],
			gate: stubGate({ kind: "deny" }),
		});
		const outcome = await tools[0]?.execute({
			input: { path: "any.ts" },
			toolCallId: "call-1",
		});
		expect(outcome).toEqual({
			errorText: "Tool call was blocked",
			type: "failure",
		});
	});

	test("skips the Gate entirely when the execution is already aborted", async () => {
		let gateCalls = 0;
		const gate: ToolGate = {
			gate: async () => {
				gateCalls += 1;
				return { kind: "allow" };
			},
		};
		const tools = createGatedCodingTools({
			agentTools: ["read"],
			gate,
		});
		const controller = new AbortController();
		controller.abort();
		const outcome = await tools[0]?.execute(
			{ input: { path: "any.ts" }, toolCallId: "call-1" },
			{ signal: controller.signal }
		);
		expect(outcome).toEqual({
			errorText: "Tool call aborted",
			type: "failure",
		});
		expect(gateCalls).toBe(0);
	});

	test("denies a pending Gate evaluation when the execution aborts", async () => {
		let releaseGate: (() => void) | undefined;
		const gate: ToolGate = {
			gate: () =>
				new Promise<GateOutcome>((resolve) => {
					releaseGate = () =>
						resolve({ errorText: "Gate settled after abort", kind: "deny" });
				}),
		};
		const tools = createGatedCodingTools({
			agentTools: ["read"],
			gate,
		});
		const controller = new AbortController();
		const outcomePromise = tools[0]?.execute(
			{ input: { path: "any.ts" }, toolCallId: "call-1" },
			{ signal: controller.signal }
		);
		controller.abort();
		const outcome = await outcomePromise;
		expect(outcome).toEqual({
			errorText: "Tool call aborted",
			type: "failure",
		});
		releaseGate?.();
	});

	test("resolves resource limits per execution", async () => {
		const dir = await workspaceDir();
		try {
			const target = join(dir, "notes.txt");
			await writeFile(target, "limited contents");
			let calls = 0;
			const resolveResourceLimits = (async () => ({
				read: { maxOutputBytes: 1024 },
			})) as unknown as () => Promise<ToolResourceLimits>;
			const tools = createGatedCodingTools({
				agentTools: ["read"],
				gate: stubGate({ kind: "allow" }),
				resolveResourceLimits: async () => {
					calls += 1;
					return resolveResourceLimits();
				},
			});
			const outcome = await tools[0]?.execute({
				input: { path: target },
				toolCallId: "call-1",
			});
			expect(outcome).toEqual({
				output: { content: "1:limited contents", path: target },
				type: "success",
			});
			expect(calls).toBe(1);
		} finally {
			await rm(dir, { force: true, recursive: true });
		}
	});
});

describe("runtime checkpoint durability", () => {
	const streamEvents = (events: AgentTurnEvent[]): AgentRuntime => ({
		run: (turn: AgentTurn) => {
			expect(turn.id).toBe("turn-1");
			return {
				async *[Symbol.asyncIterator]() {
					for (const event of events) {
						yield event;
					}
				},
			};
		},
	});
	const consume = async (stream: ReadableStream<UIMessageChunk>) => {
		const reader = stream.getReader();
		while (true) {
			const { done } = await reader.read();
			if (done) {
				break;
			}
		}
	};

	test("a live streamed turn persists exactly one record and zero delta rows", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-checkpoint-"));
		const databasePath = join(dir, "conversation.sqlite");
		const { db } = createDatabase(databasePath);
		runMigrations(db);
		const store: ConversationStore = createDrizzleConversationStore(db, {
			attachmentRoot: join(dir, "attachments"),
		});
		const { id: sessionId } = await store.createSession({
			agent: "build",
			message: {
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
			model: { modelId: "gpt-5.4-mini", providerId: "openai" },
		});
		const turn = buildAgentTurn({
			agent: "build",
			modelMessages: [userMessage("hello")],
			modelTarget,
			resolvedAgent: agent,
			turnId: "turn-1",
		});

		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				await store.commitConversationRecord({ record, sessionId });
			},
			runtime: streamEvents([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{
					modelId: "gpt-5.4-mini",
					sequence: 1,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-started",
				},
				{ delta: "hi", sequence: 2, turnId: "turn-1", type: "text-delta" },
				{
					sequence: 3,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
				},
				{
					finishedAt: 4,
					sequence: 4,
					turnId: "turn-1",
					type: "agent-turn-completed",
					usage: { inputTokens: 4, outputTokens: 1 },
				},
			]),
			turn,
		});
		await consume(stream);

		const records = await store.listConversationRecords(sessionId);
		expect(records).toHaveLength(1);
		// The committed assistant text is the assembled delta stream and no
		// per-delta row exists anywhere.
		expect(records[0]?.messages).toEqual([
			{
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
			{
				id: "assistant-turn-1",
				parts: [{ text: "hi", type: "text" }],
				role: "assistant",
			},
		]);
	});

	test("persists committed Tool Call parts with outcome and sequence, and strips history tool messages", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wincode-checkpoint-"));
		const databasePath = join(dir, "conversation.sqlite");
		const { db } = createDatabase(databasePath);
		runMigrations(db);
		const store: ConversationStore = createDrizzleConversationStore(db, {
			attachmentRoot: join(dir, "attachments"),
		});
		const { id: sessionId } = await store.createSession({
			agent: "build",
			message: {
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
			model: { modelId: "gpt-5.4-mini", providerId: "openai" },
		});
		const turn = buildAgentTurn({
			agent: "build",
			modelMessages: [
				userMessage("read it"),
				assistantMessage([outputToolPart("call-prev")]),
			],
			modelTarget,
			resolvedAgent: { instructions: "x", visibleCodingTools: ["read"] },
			turnId: "turn-1",
		});

		const stream = await createRuntimeStream({
			onCheckpoint: async (record) => {
				await store.commitConversationRecord({ record, sessionId });
			},
			runtime: streamEvents([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{
					input: { path: "b.ts" },
					sequence: 1,
					toolCallId: "call-2",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-started",
				},
				{
					outcome: { output: { text: "b contents" }, type: "success" },
					sequence: 2,
					toolCallId: "call-2",
					toolName: "read",
					turnId: "turn-1",
					type: "tool-call-finished",
				},
				{
					finishedAt: 3,
					sequence: 3,
					turnId: "turn-1",
					type: "agent-turn-completed",
				},
			]),
			turn,
		});
		await consume(stream);

		const records = await store.listConversationRecords(sessionId);
		expect(records).toHaveLength(1);
		const messages = records[0]?.messages as ConversationMessageRecord[];
		expect(messages[0]).toEqual({
			id: "msg-user",
			parts: [{ text: "read it", type: "text" }],
			role: "user",
		});
		// The assistant history message keeps only its committed text; the
		// replay tool-call and tool role messages are stripped from the
		// durable copy, while this turn's settled Tool Call is committed.
		expect(messages[1]).toEqual({
			id: "assistant-turn-1",
			parts: [
				{
					input: { path: "b.ts" },
					outcome: { kind: "success", output: { text: "b contents" } },
					sequence: 2,
					toolCallId: "call-2",
					toolName: "read",
					type: "tool-call",
				},
			],
			role: "assistant",
		});
		expect(messages[1]?.parts[0]).toMatchObject({
			input: { path: "b.ts" },
			sequence: 2,
			toolCallId: "call-2",
			toolName: "read",
		});
	});
});
