import { describe, expect, test } from "bun:test";
import { createModelTarget } from "@wincode/ai/model-target";
import { supportedChatModelIdSchema } from "@wincode/ai/models";
import {
	AGENT_TURN_EVENT_TERMINAL_TYPES,
	AGENT_TURN_EVENT_TYPES,
	AGENT_TURN_TERMINAL_STATUSES,
	type AgentId,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnId,
	agentIdSchema,
	isAgentTurnEvent,
	isAgentTurnTerminalEvent,
	isAgentTurnTerminalStatus,
	isAgentTurnToolCallPart,
	isAgentTurnToolFailurePart,
	isAgentTurnToolResultPart,
	isToolCallId,
	type ModelStepId,
	OPERATIONAL_FAILURE_VERSION,
	type ToolCallId,
	toSessionMessageId,
} from "../src/index";

const agentId = (value: string): AgentId => agentIdSchema.parse(value);
const modelId = (value: string) => supportedChatModelIdSchema.parse(value);
const turnId = (value: string): AgentTurnId => value as AgentTurnId;
const messageId = (value: string) => toSessionMessageId(value);
const stepId = (value: string): ModelStepId => value as ModelStepId;
const toolCallId = (value: string): ToolCallId => value as ToolCallId;

const testModelTarget = createModelTarget(
	{ modelId: modelId("gpt-5.6-luna"), providerId: "openai" },
	{ kind: "api-key", apiKey: "test-key" }
);

const baseEvent = (type: AgentTurnEvent["type"]): AgentTurnEvent => {
	const common = { sequence: 1, turnId: turnId("turn-1") };
	switch (type) {
		case "agent-turn-started":
			return { ...common, agentId: agentId("build"), startedAt: 0, type };
		case "model-step-started":
			return { ...common, stepId: stepId("step-1"), type };
		case "text-delta":
		case "reasoning-delta":
			return { ...common, delta: "x", type };
		case "model-step-finished":
			return { ...common, stepId: stepId("step-1"), type };
		case "tool-call-started":
			return {
				...common,
				input: { path: "src/index.ts" },
				toolCallId: toolCallId("call-1"),
				toolName: "read",
				type,
			};
		case "tool-call-finished":
			return {
				...common,
				outcome: {
					output: { content: "x", path: "src/index.ts" },
					type: "success",
				},
				toolCallId: toolCallId("call-1"),
				toolName: "read",
				type,
			};
		case "agent-turn-completed":
			return { ...common, finishedAt: 1, type };
		case "agent-turn-cancelled":
			return {
				...common,
				failure: {
					code: "cancelled",
					message: "The Agent Turn was cancelled.",
					retry: "never",
					source: "runtime",
					version: OPERATIONAL_FAILURE_VERSION,
				},
				finishedAt: 1,
				type,
			};
		case "agent-turn-interrupted":
			return {
				...common,
				failure: {
					code: "interrupted",
					message: "The Agent Turn was interrupted.",
					retry: "immediate",
					source: "runtime",
					version: OPERATIONAL_FAILURE_VERSION,
				},
				finishedAt: 1,
				reason: "lost-execution",
				type,
			};
		case "agent-turn-failed":
			return {
				...common,
				failure: {
					code: "unknown",
					message: "The model request failed.",
					retry: "never",
					source: "model",
					version: OPERATIONAL_FAILURE_VERSION,
				},
				finishedAt: 1,
				type,
			};
		default:
			throw new Error(`Unhandled event type: ${type}`);
	}
};

describe("Agent Turn Event contract", () => {
	test("every event carries Agent Turn identity and a monotonic sequence", () => {
		for (const type of AGENT_TURN_EVENT_TYPES) {
			const event = baseEvent(type);
			expect(isAgentTurnEvent(event)).toBe(true);
			expect(typeof event.turnId).toBe("string");
			expect(typeof event.sequence).toBe("number");
		}
	});

	test("distinguishes terminal from live events", () => {
		for (const type of AGENT_TURN_EVENT_TERMINAL_TYPES) {
			expect(isAgentTurnTerminalEvent(baseEvent(type))).toBe(true);
		}
		for (const type of AGENT_TURN_EVENT_TYPES) {
			const event = baseEvent(type);
			expect(isAgentTurnTerminalEvent(event)).toBe(
				AGENT_TURN_EVENT_TERMINAL_TYPES.includes(
					type as (typeof AGENT_TURN_EVENT_TERMINAL_TYPES)[number]
				)
			);
		}
	});

	test("rejects non-events", () => {
		expect(isAgentTurnEvent(null)).toBe(false);
		expect(isAgentTurnEvent({})).toBe(false);
		expect(isAgentTurnEvent({ sequence: 1, type: "text-delta" })).toBe(false);
		expect(
			isAgentTurnEvent({ sequence: 1, turnId: 1, type: "text-delta" })
		).toBe(false);
	});

	test("rejects malformed Tool Call events", () => {
		expect(
			isAgentTurnEvent({
				sequence: 1,
				toolCallId: "",
				toolName: "read",
				turnId: "turn-1",
				type: "tool-call-started",
			})
		).toBe(false);
		expect(
			isAgentTurnEvent({
				sequence: 1,
				toolName: "read",
				turnId: "turn-1",
				type: "tool-call-started",
			})
		).toBe(false);
		expect(
			isAgentTurnEvent({
				outcome: { errorText: "nope", type: "failure" },
				sequence: 1,
				toolCallId: "call-1",
				toolName: "",
				turnId: "turn-1",
				type: "tool-call-finished",
			})
		).toBe(false);
		expect(
			isAgentTurnEvent({
				sequence: 1,
				toolCallId: "call-1",
				toolName: "read",
				turnId: "turn-1",
				type: "tool-call-finished",
			})
		).toBe(false);
	});
});

describe("delegated Agent Turn correlation", () => {
	test("validates delegation on the turn start event", () => {
		const event = {
			...baseEvent("agent-turn-started"),
			delegation: {
				parentToolCallId: toolCallId("call-1"),
				parentTurnId: turnId("turn-primary"),
			},
		};
		expect(isAgentTurnEvent(event)).toBe(true);
		expect(
			isAgentTurnEvent({
				...event,
				delegation: { parentTurnId: "turn-primary" },
			})
		).toBe(false);
	});

	test("keeps delegated turns distinct from their parent identity", () => {
		const parent: AgentTurn = {
			agent: {
				id: agentId("build"),
				instructions: "x",
				role: "primary",
			},
			id: turnId("turn-primary"),
			input: { messages: [] },
			model: testModelTarget,
		};
		const delegated: AgentTurn = {
			...parent,
			agent: { ...parent.agent, id: agentId("research"), role: "subagent" },
			delegation: {
				parentToolCallId: toolCallId("call-1"),
				parentTurnId: parent.id,
			},
			id: turnId("turn-subagent"),
		};
		expect(delegated.id).not.toBe(parent.id);
		expect(delegated.delegation?.parentTurnId).toBe(parent.id);
		expect(delegated.delegation?.parentToolCallId).toBe(toolCallId("call-1"));
	});
});

describe("Agent Turn message part contract", () => {
	test("validates text, tool-call, tool-result, and tool-failure parts", () => {
		expect(
			isAgentTurnToolCallPart({
				input: { path: "x" },
				toolCallId: "c1",
				toolName: "read",
				type: "tool-call",
			})
		).toBe(true);
		expect(
			isAgentTurnToolResultPart({
				output: { content: "x", path: "x" },
				toolCallId: "c1",
				toolName: "read",
				type: "tool-result",
			})
		).toBe(true);
		expect(
			isAgentTurnToolFailurePart({
				errorText: "denied",
				toolCallId: "c1",
				toolName: "read",
				type: "tool-failure",
			})
		).toBe(true);
	});

	test("rejects malformed tool parts", () => {
		expect(
			isAgentTurnToolCallPart({
				input: { path: "x" },
				toolCallId: "c1",
				toolName: "read",
			})
		).toBe(false);
		expect(
			isAgentTurnToolCallPart({
				input: { path: "x" },
				toolCallId: "c1",
				toolName: "read",
				type: "tool-result",
			})
		).toBe(false);
		expect(
			isAgentTurnToolResultPart({
				toolCallId: "c1",
				toolName: "read",
				type: "tool-result",
			})
		).toBe(false);
		expect(
			isAgentTurnToolFailurePart({
				errorText: "",
				toolCallId: "c1",
				toolName: "read",
				type: "tool-failure",
			})
		).toBe(false);
	});
});

describe("Agent Turn terminal status contract", () => {
	test("declares the terminal outcome taxonomy", () => {
		expect(AGENT_TURN_TERMINAL_STATUSES).toEqual([
			"completed",
			"failed",
			"cancelled",
			"interrupted",
		]);
		for (const status of AGENT_TURN_TERMINAL_STATUSES) {
			expect(isAgentTurnTerminalStatus(status)).toBe(true);
		}
		expect(isAgentTurnTerminalStatus("running")).toBe(false);
		expect(isAgentTurnTerminalStatus(undefined)).toBe(false);
	});
});

describe("Agent Turn contract", () => {
	test("is fully resolved for one runtime invocation", () => {
		const turn = {
			agent: {
				displayName: "Build",
				id: agentId("build"),
				instructions: "Implement changes.",
				role: "primary",
			},
			id: turnId("turn-1"),
			input: {
				messages: [
					{
						id: messageId("msg-1"),
						parts: [{ text: "hello", type: "text" }],
						role: "user",
					},
				],
			},
			model: testModelTarget,
		} satisfies AgentTurn;
		expect(turn.input.messages[0]?.parts[0]).toEqual({
			text: "hello",
			type: "text",
		});
		expect(turn.agent.role).toBe("primary");
	});
});

describe("Branded identifier boundaries", () => {
	test("accepts non-empty tool call ids and rejects missing ids", () => {
		expect(isToolCallId(toolCallId("call-1"))).toBe(true);
		expect(isToolCallId("")).toBe(false);
		expect(isToolCallId(undefined)).toBe(false);
	});
});
