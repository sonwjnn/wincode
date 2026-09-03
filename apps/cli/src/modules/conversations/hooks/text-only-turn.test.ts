import { describe, expect, test } from "bun:test";
import type {
	AgentRuntime,
	AgentTurn,
	AgentTurnEvent,
} from "@wincode/agent-core";
import type { CodingAgentUIMessage, ResolvedAgentRuntime } from "@wincode/ai";
import { createModelTarget } from "@wincode/ai/model-target";
import type { UIMessageChunk } from "ai";
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

	test("rejects interrupted turns", () => {
		const interrupted = {
			...userMessage("x"),
			metadata: { interrupted: true },
		} as CodingAgentUIMessage;
		expect(
			isTextOnlyEligibleSend({
				mcpManifest: [],
				messages: [interrupted],
				resolvedAgent: agent,
				skill: undefined,
				skillTool: undefined,
			})
		).toBe(false);
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
		expect(chunks).toEqual([{ errorText: "provider blew up", type: "error" }]);
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
});
