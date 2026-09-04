import type { ModelTarget } from "@wincode/ai/model-target";
import type { ResolvedAgent } from "./agent";
import type { ResolvedTool, ToolCallId } from "./tools";

/** Opaque identity of one Agent Turn. */
export type AgentTurnId = string;

export const AGENT_TURN_STATUSES = [
	"running",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
] as const;
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];

/**
 * Terminal statuses an Agent Turn may reach. A turn has exactly one terminal
 * status; interruption is distinct from caller cancellation and failure.
 */
export const AGENT_TURN_TERMINAL_STATUSES = [
	"completed",
	"failed",
	"cancelled",
	"interrupted",
] as const;
export type AgentTurnTerminalStatus =
	(typeof AGENT_TURN_TERMINAL_STATUSES)[number];

export const isAgentTurnTerminalStatus = (
	value: unknown
): value is AgentTurnTerminalStatus =>
	typeof value === "string" &&
	(AGENT_TURN_TERMINAL_STATUSES as readonly string[]).includes(value);

export const AGENT_TURN_INTERRUPTION_REASONS = [
	"lost-execution",
	"user",
] as const;
export type AgentTurnInterruptionReason =
	(typeof AGENT_TURN_INTERRUPTION_REASONS)[number];

/** Creates an opaque identity for one new Agent Turn. */
export const createAgentTurnId = (): AgentTurnId =>
	`turn-${crypto.randomUUID()}`;

/** A Wincode-owned text content part; AI SDK part shapes never cross here. */
export type AgentTurnTextPart = {
	readonly text: string;
	readonly type: "text";
};

/** One Assistant request to invoke a tool; its result arrives in a later `tool` message. */
export type AgentTurnToolCallPart = {
	readonly input: unknown;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly type: "tool-call";
};

/** One `tool` role message carrying a successful Tool Call output. */
export type AgentTurnToolResultPart = {
	readonly output: unknown;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly type: "tool-result";
};

/** One `tool` role message carrying a safe Tool Call failure text. */
export type AgentTurnToolFailurePart = {
	readonly errorText: string;
	readonly toolCallId: ToolCallId;
	readonly toolName: string;
	readonly type: "tool-failure";
};

/** A Wincode-owned message content part; AI SDK part shapes never cross here. */
export type AgentTurnPart =
	| AgentTurnTextPart
	| AgentTurnToolCallPart
	| AgentTurnToolResultPart
	| AgentTurnToolFailurePart;

/** A Wincode-owned message. `tool` messages carry Tool Call results. */
export type AgentTurnMessage = {
	readonly id: string;
	readonly parts: readonly AgentTurnPart[];
	readonly role: "assistant" | "tool" | "user";
};

/** One resolved input to an Agent Turn: the conversation so far. */
export type AgentTurnInput = {
	readonly messages: readonly AgentTurnMessage[];
};

/**
 * Correlation for a delegated Subagent execution. Both identifiers are
 * present together so a delegated turn can be located from either side.
 */
export type AgentTurnDelegation = {
	readonly parentToolCallId: ToolCallId;
	readonly parentTurnId: AgentTurnId;
};

/**
 * A fully resolved Agent Turn ready for one runtime invocation: the Agent,
 * the transient Model Target, the input conversation, and the gated Tools
 * the Agent may invoke. Delegated turns retain the parent turn and Tool Call
 * that created them while keeping their own identity and lifecycle.
 */
export type AgentTurn = {
	readonly agent: ResolvedAgent;
	readonly delegation?: AgentTurnDelegation;
	readonly id: AgentTurnId;
	readonly input: AgentTurnInput;
	readonly model: ModelTarget;
	readonly tools?: readonly ResolvedTool[];
};

export const isAgentTurnDelegation = (
	value: unknown
): value is AgentTurnDelegation => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const delegation = value as Record<string, unknown>;
	const keys = Object.keys(delegation);
	return (
		keys.length === 2 &&
		keys.includes("parentTurnId") &&
		keys.includes("parentToolCallId") &&
		typeof delegation.parentTurnId === "string" &&
		delegation.parentTurnId.length > 0 &&
		typeof delegation.parentToolCallId === "string" &&
		delegation.parentToolCallId.length > 0
	);
};
export const createAgentTurnMessage = (
	role: AgentTurnMessage["role"],
	text: string,
	id = `${role}-${Date.now()}`
): AgentTurnMessage => ({
	id,
	parts: [{ text, type: "text" }],
	role,
});

export const isAgentTurnTextPart = (
	part: unknown
): part is AgentTurnTextPart => {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const value = part as Record<string, unknown>;
	return (
		Object.keys(value).every((key) => key === "text" || key === "type") &&
		value.type === "text" &&
		typeof value.text === "string"
	);
};

export const isAgentTurnToolCallPart = (
	part: unknown
): part is AgentTurnToolCallPart => {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const value = part as Record<string, unknown>;
	return (
		Object.keys(value).every(
			(key) =>
				key === "input" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-call" &&
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0 &&
		typeof value.toolName === "string" &&
		value.toolName.length > 0 &&
		"input" in value
	);
};

export const isAgentTurnToolResultPart = (
	part: unknown
): part is AgentTurnToolResultPart => {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const value = part as Record<string, unknown>;
	return (
		Object.keys(value).every(
			(key) =>
				key === "output" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-result" &&
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0 &&
		typeof value.toolName === "string" &&
		value.toolName.length > 0 &&
		"output" in value
	);
};

export const isAgentTurnToolFailurePart = (
	part: unknown
): part is AgentTurnToolFailurePart => {
	if (typeof part !== "object" || part === null) {
		return false;
	}
	const value = part as Record<string, unknown>;
	return (
		Object.keys(value).every(
			(key) =>
				key === "errorText" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-failure" &&
		typeof value.toolCallId === "string" &&
		value.toolCallId.length > 0 &&
		typeof value.toolName === "string" &&
		value.toolName.length > 0 &&
		typeof value.errorText === "string" &&
		value.errorText.length > 0
	);
};

export const isAgentTurnPart = (part: unknown): part is AgentTurnPart =>
	isAgentTurnTextPart(part) ||
	isAgentTurnToolCallPart(part) ||
	isAgentTurnToolResultPart(part) ||
	isAgentTurnToolFailurePart(part);
