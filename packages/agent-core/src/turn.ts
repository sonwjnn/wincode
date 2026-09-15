import type { ModelTarget } from "@wincode/ai/model-target";
import { isNonEmptyString, isObjectLike } from "@wincode/runtime-utils";
import type { ReadonlyDeep, UnknownRecord } from "type-fest";
import type { ResolvedAgent } from "./agent";
import {
	type AgentTurnId,
	type SessionMessageId,
	toAgentTurnId,
	toSessionMessageId,
} from "./identifiers";
import { isToolCallId, type ResolvedTool, type ToolCallId } from "./tools";

export type { AgentTurnId } from "./identifiers";

/** Opaque identity of one Agent Turn. */

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
	toAgentTurnId(`turn-${crypto.randomUUID()}`);

/** A Wincode-owned text content part; AI SDK part shapes never cross here. */
export type AgentTurnTextPart = Readonly<{
	text: string;
	type: "text";
}>;

/** One provider-neutral file or image part supplied to the Model. */
export type AgentTurnFilePart = Readonly<{
	data: string | Uint8Array;
	mediaType: string;
	type: "file";
}>;

/** One Assistant request to invoke a tool; its result arrives in a later `tool` message. */
export type AgentTurnToolCallPart = Readonly<{
	input: unknown;
	toolCallId: ToolCallId;
	toolName: string;
	type: "tool-call";
}>;

/** One `tool` role message carrying a successful Tool Call output. */
export type AgentTurnToolResultPart = Readonly<{
	output: unknown;
	toolCallId: ToolCallId;
	toolName: string;
	type: "tool-result";
}>;

/** One `tool` role message carrying a safe Tool Call failure text. */
export type AgentTurnToolFailurePart = Readonly<{
	errorText: string;
	toolCallId: ToolCallId;
	toolName: string;
	type: "tool-failure";
}>;

/** A Wincode-owned message content part; AI SDK part shapes never cross here. */
export type AgentTurnPart =
	| AgentTurnTextPart
	| AgentTurnFilePart
	| AgentTurnToolCallPart
	| AgentTurnToolResultPart
	| AgentTurnToolFailurePart;

/** A Wincode-owned message. `tool` messages carry Tool Call results. */
export type AgentTurnMessage = ReadonlyDeep<{
	id: SessionMessageId;
	parts: AgentTurnPart[];
	role: "assistant" | "tool" | "user";
}>;

/** One resolved input to an Agent Turn: the session so far. */
export type AgentTurnInput = ReadonlyDeep<{
	messages: AgentTurnMessage[];
}>;

/**
 * Correlation for a delegated Subagent execution. Both identifiers are
 * present together so a delegated turn can be located from either side.
 */
export type AgentTurnDelegation = Readonly<{
	parentToolCallId: ToolCallId;
	parentTurnId: AgentTurnId;
}>;

/**
 * A fully resolved Agent Turn ready for one runtime invocation: the Agent,
 * the transient Model Target, the input session, and the gated Tools
 * the Agent may invoke. Delegated turns retain the parent turn and Tool Call
 * that created them while keeping their own identity and lifecycle.
 */
export type AgentTurn = Readonly<{
	agent: ResolvedAgent;
	delegation?: AgentTurnDelegation;
	id: AgentTurnId;
	input: AgentTurnInput;
	model: ModelTarget;
	tools?: readonly ResolvedTool[];
}>;

export const isAgentTurnDelegation = (
	value: unknown
): value is AgentTurnDelegation => {
	if (!isObjectLike(value)) {
		return false;
	}
	const delegation = value as UnknownRecord;
	const keys = Object.keys(delegation);
	return (
		keys.length === 2 &&
		keys.includes("parentTurnId") &&
		keys.includes("parentToolCallId") &&
		isNonEmptyString(delegation.parentTurnId) &&
		isToolCallId(delegation.parentToolCallId)
	);
};
export const createAgentTurnMessage = (
	role: AgentTurnMessage["role"],
	text: string,
	id = toSessionMessageId(`${role}-${Date.now()}`)
): AgentTurnMessage => ({
	id,
	parts: [{ text, type: "text" }],
	role,
});

export const isAgentTurnTextPart = (
	part: unknown
): part is AgentTurnTextPart => {
	if (!isObjectLike(part)) {
		return false;
	}
	const value = part as UnknownRecord;
	return (
		Object.keys(value).every((key) => key === "text" || key === "type") &&
		value.type === "text" &&
		typeof value.text === "string"
	);
};

export const isAgentTurnFilePart = (
	part: unknown
): part is AgentTurnFilePart => {
	if (!isObjectLike(part)) {
		return false;
	}
	const value = part as UnknownRecord;
	return (
		Object.keys(value).every(
			(key) => key === "data" || key === "mediaType" || key === "type"
		) &&
		value.type === "file" &&
		(typeof value.data === "string" || value.data instanceof Uint8Array) &&
		isNonEmptyString(value.mediaType)
	);
};

export const isAgentTurnToolCallPart = (
	part: unknown
): part is AgentTurnToolCallPart => {
	if (!isObjectLike(part)) {
		return false;
	}
	const value = part as UnknownRecord;
	return (
		Object.keys(value).every(
			(key) =>
				key === "input" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-call" &&
		isToolCallId(value.toolCallId) &&
		isNonEmptyString(value.toolName) &&
		"input" in value
	);
};

export const isAgentTurnToolResultPart = (
	part: unknown
): part is AgentTurnToolResultPart => {
	if (!isObjectLike(part)) {
		return false;
	}
	const value = part as UnknownRecord;
	return (
		Object.keys(value).every(
			(key) =>
				key === "output" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-result" &&
		isToolCallId(value.toolCallId) &&
		isNonEmptyString(value.toolName) &&
		"output" in value
	);
};

export const isAgentTurnToolFailurePart = (
	part: unknown
): part is AgentTurnToolFailurePart => {
	if (!isObjectLike(part)) {
		return false;
	}
	const value = part as UnknownRecord;
	return (
		Object.keys(value).every(
			(key) =>
				key === "errorText" ||
				key === "toolCallId" ||
				key === "toolName" ||
				key === "type"
		) &&
		value.type === "tool-failure" &&
		isToolCallId(value.toolCallId) &&
		isNonEmptyString(value.toolName) &&
		isNonEmptyString(value.errorText)
	);
};

export const isAgentTurnPart = (part: unknown): part is AgentTurnPart =>
	isAgentTurnTextPart(part) ||
	isAgentTurnFilePart(part) ||
	isAgentTurnToolCallPart(part) ||
	isAgentTurnToolResultPart(part) ||
	isAgentTurnToolFailurePart(part);
