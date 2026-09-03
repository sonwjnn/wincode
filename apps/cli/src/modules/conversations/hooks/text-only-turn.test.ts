import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
	ConversationRecord,
} from "@wincode/agent-core";
import { createAgentTurnAbortReason } from "@wincode/agent-core";
import type { CodingAgentUIMessage, ResolvedAgentRuntime } from "@wincode/ai";
import { createModelTarget } from "@wincode/ai/model-target";
import type { UIMessageChunk } from "ai";
import { createDatabase } from "../storage/client";
import type { ConversationStore } from "../storage/conversation-store";
import { createDrizzleConversationStore } from "../storage/drizzle-conversation-store";
import { runMigrations } from "../storage/migrations";
import {
	buildTextOnlyAgentTurn,
	createTextOnlyRuntimeStream,
	isTextOnlyEligibleSend,
} from "./text-only-turn";

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

describe("isTextOnlyEligibleSend", () => {
	test("accepts a pure text conversation for a tool-less Agent", () => {
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [userMessage("hello")],
				resolvedAgent: agent,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(true);
	});

	test("rejects tool-armed Agents", () => {
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [userMessage("hello")],
				resolvedAgent: { instructions: "x", visibleCodingTools: ["read"] },
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
	});

	test("rejects MCP tools and Skill activation", () => {
		const base = {
			messages: [userMessage("hello")],
			resolvedAgent: agent,
		};
		expect(
			isTextOnlyEligibleSend({
				...base,
				mcpManifest: [
					{ description: "mcp tool", inputSchema: {}, name: "mcp-tool" },
				],
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
		expect(
			isTextOnlyEligibleSend({
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

	test("rejects tool and file parts in history", () => {
		const withToolPart = {
			id: "msg-tool",
			parts: [
				{ type: "text", text: "done" },
				{ type: "tool-read", toolCallId: "call-1", state: "input-available" },
			],
			role: "assistant",
		} as unknown as CodingAgentUIMessage;
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [userMessage("x"), withToolPart],
				resolvedAgent: agent,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);

		const withFilePart = {
			id: "msg-file",
			parts: [{ type: "file", url: "file:///x" }],
			role: "user",
		} as unknown as CodingAgentUIMessage;
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [withFilePart],
				resolvedAgent: agent,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
	});

	test("accepts text-only interrupted history for a fresh retry turn", () => {
		const interrupted = {
			id: "msg-assistant",
			metadata: { interrupted: true },
			parts: [{ text: "partial", type: "text" }],
			role: "assistant",
		} as unknown as CodingAgentUIMessage;
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [userMessage("x"), interrupted],
				resolvedAgent: agent,
				skill: undefined,
				skillTool: undefined,
			})
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
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [userMessage("x"), reasoningOnly, userMessage("y")],
				resolvedAgent: agent,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
	});

	test("rejects a missing resolved Agent", () => {
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [userMessage("x")],
				resolvedAgent: undefined,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
	});
});

describe("buildTextOnlyAgentTurn", () => {
	test("composes instructions and strips UI-only parts", () => {
		const turn = buildTextOnlyAgentTurn({
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
	});
});

describe("createTextOnlyRuntimeStream", () => {
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
		buildTextOnlyAgentTurn({
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

	test("maps a completed turn to the executor display chunk protocol", async () => {
		const stream = await createTextOnlyRuntimeStream({
			runtime: runtimeWith([
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
				{ delta: "Hel", sequence: 2, turnId: "turn-1", type: "text-delta" },
				{ delta: "lo", sequence: 3, turnId: "turn-1", type: "text-delta" },
				{
					sequence: 4,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
					usage: { inputTokens: 3, outputTokens: 2 },
				},
				{
					finishedAt: 5,
					sequence: 5,
					turnId: "turn-1",
					type: "agent-turn-completed",
					usage: { inputTokens: 3, outputTokens: 2 },
				},
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
		const stream = await createTextOnlyRuntimeStream({
			runtime: runtimeWith([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{
					failure: {
						code: "unknown",
						message: "provider blew up",
						retry: "never",
						source: "model",
						version: 1,
					},
					finishedAt: 2,
					sequence: 1,
					turnId: "turn-1",
					type: "agent-turn-failed",
				},
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
		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{
					failure: {
						code: "unknown",
						message: "provider response contains secret-token",
						retry: "never",
						source: "model",
						version: 1,
					},
					finishedAt: 2,
					sequence: 1,
					turnId: "turn-1",
					type: "agent-turn-failed",
				},
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
		const stream = await createTextOnlyRuntimeStream({
			runtime: runtimeWith([
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
				{
					finishedAt: 5,
					sequence: 5,
					turnId: "turn-1",
					type: "agent-turn-completed",
				},
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

	test("commits one semantic checkpoint with assembled text and usage before the terminal chunk", async () => {
		const checkpoints: ConversationRecord[] = [];
		const log: string[] = [];
		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async (record) => {
				log.push("checkpoint");
				checkpoints.push(record);
			},
			runtime: runtimeWith([
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
				{
					delta: "think",
					sequence: 2,
					turnId: "turn-1",
					type: "reasoning-delta",
				},
				{ delta: "Hel", sequence: 3, turnId: "turn-1", type: "text-delta" },
				{ delta: "lo", sequence: 4, turnId: "turn-1", type: "text-delta" },
				{
					sequence: 5,
					stepId: "step-1",
					turnId: "turn-1",
					type: "model-step-finished",
				},
				{
					finishedAt: 6,
					sequence: 6,
					turnId: "turn-1",
					type: "agent-turn-completed",
					usage: { inputTokens: 3, outputTokens: 2 },
				},
			]),
			turn: buildTurn(),
		});

		const chunks = await consume(stream);
		expect(chunks).toEqual([
			{ type: "start-step" },
			{ id: "reasoning-1", type: "reasoning-start" },
			{ delta: "think", id: "reasoning-1", type: "reasoning-delta" },
			{ id: "text-1", type: "text-start" },
			{ delta: "Hel", id: "text-1", type: "text-delta" },
			{ delta: "lo", id: "text-1", type: "text-delta" },
			{ id: "text-1", type: "text-end" },
			{ id: "reasoning-1", type: "reasoning-end" },
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
		expect(record?.messages).toEqual([
			{
				id: "msg-user",
				parts: [{ text: "hello", type: "text" }],
				role: "user",
			},
			{
				id: "assistant-turn-1",
				parts: [{ text: "Hello", type: "text" }],
				role: "assistant",
			},
		]);
		// The checkpoint is durable before the terminal display chunk: text
		// deltas are the only chunks that precede it.
		const chunkTypes = chunks.map((chunk) => chunk.type);
		expect(log.indexOf("checkpoint")).toBeLessThan(
			chunkTypes.indexOf("finish")
		);
	});

	test("commits a failed turn with its committed input messages", async () => {
		const checkpoints: ConversationRecord[] = [];
		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{ delta: "partial", sequence: 1, turnId: "turn-1", type: "text-delta" },
				{
					failure: {
						code: "unknown",
						message: "provider blew up",
						retry: "never",
						source: "model",
						version: 1,
					},
					finishedAt: 2,
					sequence: 2,
					turnId: "turn-1",
					type: "agent-turn-failed",
				},
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
		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async (record) => {
				checkpoints.push(record);
			},
			runtime: runtimeWith([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
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
					yield {
						agentId: "build",
						sequence: 0,
						startedAt: 1,
						turnId: "turn-1",
						type: "agent-turn-started" as const,
					};
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
		const stream = await createTextOnlyRuntimeStream({
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
		const runtime = runtimeWith([
			{
				agentId: "build",
				sequence: 0,
				startedAt: 1,
				turnId: "turn-1",
				type: "agent-turn-started",
			},
		]);
		const stream = await createTextOnlyRuntimeStream({
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
		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async () => {
				throw new Error("disk full");
			},
			runtime: runtimeWith([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{
					finishedAt: 2,
					sequence: 1,
					turnId: "turn-1",
					type: "agent-turn-completed",
				},
			]),
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
		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async () => {
				throw new Error("disk full");
			},
			runtime: runtimeWith([
				{
					agentId: "build",
					sequence: 0,
					startedAt: 1,
					turnId: "turn-1",
					type: "agent-turn-started",
				},
				{
					failure: {
						code: "rate-limited",
						message: "slow down",
						retry: "after-delay",
						source: "model",
						version: 1,
					},
					finishedAt: 2,
					sequence: 1,
					turnId: "turn-1",
					type: "agent-turn-failed",
				},
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

describe("text-only runtime checkpoint durability", () => {
	const modelTarget = createModelTarget(
		{ modelId: "gpt-5.4-mini", providerId: "openai" },
		{ kind: "api-key", apiKey: "test-key" }
	);
	const turnEvents = (): AgentTurnEvent[] => [
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
		{ delta: "think", sequence: 2, turnId: "turn-1", type: "reasoning-delta" },
		{ delta: "hi", sequence: 3, turnId: "turn-1", type: "text-delta" },
		{
			sequence: 4,
			stepId: "step-1",
			turnId: "turn-1",
			type: "model-step-finished",
		},
		{
			finishedAt: 5,
			sequence: 5,
			turnId: "turn-1",
			type: "agent-turn-completed",
			usage: { inputTokens: 4, outputTokens: 1 },
		},
	];
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
		const turn = buildTextOnlyAgentTurn({
			agent: "build",
			modelMessages: [userMessage("hello")],
			modelTarget,
			resolvedAgent: agent,
			turnId: "turn-1",
		});

		const stream = await createTextOnlyRuntimeStream({
			onCheckpoint: async (record) => {
				await store.commitConversationRecord({ record, sessionId });
			},
			runtime: streamEvents(turnEvents()),
			turn,
		});
		await consume(stream);

		const records = await store.listConversationRecords(sessionId);
		expect(records).toHaveLength(1);
		// The committed assistant text is the assembled delta stream; the
		// reasoning delta is absent and no per-delta row exists anywhere.
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
});
