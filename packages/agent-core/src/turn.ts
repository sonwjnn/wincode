import type { ModelTarget } from "@wincode/ai/model-target";
import type { ResolvedAgent } from "./agent";

/** Opaque identity of one Agent Turn. */
export type AgentTurnId = string;

export const AGENT_TURN_STATUSES = ["running", "completed", "failed"] as const;
export type AgentTurnStatus = (typeof AGENT_TURN_STATUSES)[number];

/**
 * Terminal statuses an Agent Turn may reach. Interruption and cancellation
 * arrive with the operational failure ticket; the taxonomy is declared here so
 * records and projections can name them.
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

/** A Wincode-owned text content part; AI SDK part shapes never cross here. */
export type AgentTurnTextPart = {
	readonly text: string;
	readonly type: "text";
};

/** A Wincode-owned message: roles and text content only, no SDK shapes. */
export type AgentTurnMessage = {
	readonly id: string;
	readonly parts: readonly AgentTurnTextPart[];
	readonly role: "assistant" | "user";
};

/** One resolved input to an Agent Turn: the conversation so far. */
export type AgentTurnInput = {
	readonly messages: readonly AgentTurnMessage[];
};

/**
 * A fully resolved Agent Turn ready for one runtime invocation: the Agent,
 * the transient Model Target, and the input conversation.
 */
export type AgentTurn = {
	readonly agent: ResolvedAgent;
	readonly id: AgentTurnId;
	readonly input: AgentTurnInput;
	readonly model: ModelTarget;
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

export const isAgentTurnTextPart = (part: unknown): part is AgentTurnTextPart =>
	typeof part === "object" &&
	part !== null &&
	(part as AgentTurnTextPart).type === "text" &&
	typeof (part as AgentTurnTextPart).text === "string";
