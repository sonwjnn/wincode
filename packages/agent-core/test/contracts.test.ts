import { describe, expect, test } from "bun:test";
import {
	AGENT_TURN_EVENT_TERMINAL_TYPES,
	AGENT_TURN_EVENT_TYPES,
	AGENT_TURN_TERMINAL_STATUSES,
	type AgentId,
	type AgentTurn,
	type AgentTurnEvent,
	type AgentTurnId,
	agentIdSchema,
	agentLabelFromId,
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
	toModelId,
	toSessionMessageId,
} from "../src/index";

const agentId = (value: string): AgentId => agentIdSchema.parse(value);
const modelId = (value: string) => toModelId(value);
const turnId = (value: string): AgentTurnId => value as AgentTurnId;
const messageId = (value: string) => toSessionMessageId(value);
const stepId = (value: string): ModelStepId => value as ModelStepId;
const toolCallId = (value: string): ToolCallId => value as ToolCallId;

const testModel = {
	modelId: modelId("gpt-5.6-luna"),
	providerId: "openai",
} as const;

const baseEvent = (type: AgentTurnEvent["type"]): AgentTurnEvent => {
	const common = { sequence: 1, turnId: turnId("turn-1") };
	switch (type) {
		case "agent-turn-started":
			return { ...common, agentId: agentId("build"), startedAt: 0, type };
		case "model-step-started":
			return { ...common, stepId: stepId("step-1"), type };
		case "model-step-retry-scheduled":
			return {
				...common,
				attempt: 1,
				failure: {
					code: "network",
					message: "The model connection failed.",
					retry: "after-delay",
					source: "model",
					version: OPERATIONAL_FAILURE_VERSION,
				},
				maxAttempts: 2,
				retryAt: 10,
				stepId: stepId("step-1"),
				type,
			};
		case "model-step-retry-ended":
			return {
				...common,
				attempt: 1,
				maxAttempts: 2,
				outcome: "success",
				stepId: stepId("step-2"),
				type,
			};
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

	test("retry scheduling requires a bounded attempt and retryable failure", () => {
		const retryEvent = baseEvent("model-step-retry-scheduled");
		expect(isAgentTurnEvent({ ...retryEvent, attempt: 0 })).toBe(false);
		expect(isAgentTurnEvent({ ...retryEvent, maxAttempts: 0 })).toBe(false);
		expect(
			isAgentTurnEvent({
				...retryEvent,
				failure: {
					code: "authentication",
					message: "Model authentication failed.",
					retry: "never",
					source: "model",
					version: OPERATIONAL_FAILURE_VERSION,
				},
			})
		).toBe(false);
	});

	test("retry terminal events require consistent outcomes and attempts", () => {
		const retryEnded = baseEvent("model-step-retry-ended");
		expect(isAgentTurnEvent(retryEnded)).toBe(true);
		expect(isAgentTurnEvent({ ...retryEnded, outcome: "stopped" })).toBe(false);
		expect(isAgentTurnEvent({ ...retryEnded, attempt: 3 })).toBe(false);
	});

	test("terminal attempt summaries are validated before persistence", () => {
		const terminal = baseEvent("agent-turn-completed");
		const summary = {
			attempt: 1,
			failure: {
				code: "network",
				message: "The model connection failed.",
				retry: "after-delay",
				source: "model",
				version: OPERATIONAL_FAILURE_VERSION,
			},
			maxRetries: 2,
			partialOutput: { text: "discarded fragment" },
			retryDecision: "scheduled",
			stepId: stepId("step-1"),
			usage: { inputTokens: 3, outputTokens: 1 },
		};
		expect(
			isAgentTurnEvent({ ...terminal, modelStepAttempts: [summary] })
		).toBe(true);
		expect(
			isAgentTurnEvent({
				...terminal,
				modelStepAttempts: [
					{ ...summary, partialOutput: { text: "x".repeat(4097) } },
				],
			})
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

describe("Agent Turn execution identity", () => {
	test("keeps different Session Turn executions distinct", () => {
		const parent: AgentTurn = {
			agent: {
				id: agentId("build"),
				instructions: "x",
				role: "primary",
			},
			id: turnId("turn-primary"),
			input: { messages: [] },
			model: testModel,
		};
		const subagentTurn: AgentTurn = {
			...parent,
			agent: { ...parent.agent, id: agentId("research"), role: "subagent" },
			id: turnId("turn-subagent"),
		};
		expect(subagentTurn.id).not.toBe(parent.id);
		expect(subagentTurn.agent.role).toBe("subagent");
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
			model: testModel,
		} satisfies AgentTurn;
		expect(turn.input.messages[0]?.parts[0]).toEqual({
			text: "hello",
			type: "text",
		});
		expect(turn.agent.role).toBe("primary");
	});
});

describe("Agent label contract", () => {
	test("formats kebab-case Agent IDs as readable display names", () => {
		expect(agentLabelFromId("evidence-auditor")).toBe("Evidence Auditor");
	});
});

describe("Branded identifier boundaries", () => {
	test("accepts non-empty tool call ids and rejects missing ids", () => {
		expect(isToolCallId(toolCallId("call-1"))).toBe(true);
		expect(isToolCallId("")).toBe(false);
		expect(isToolCallId(undefined)).toBe(false);
	});
});
