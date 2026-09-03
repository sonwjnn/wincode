export const MAX_AGENT_ID_LENGTH = 64;
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 12_000;
export const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const AGENT_ROLES = ["primary", "subagent", "all"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

/** Canonical lowercase kebab-case Agent identity (1-64 characters). */
export type AgentId = string;

/**
 * The resolved Agent an Agent Turn runs as: the identity, role eligibility,
 * and literal system instructions for one turn. Configured origins, model
 * pins, and permission policy stay with the composition root that resolves
 * the Agent.
 */
export type ResolvedAgent = {
	readonly description?: string;
	readonly displayName?: string;
	readonly id: AgentId;
	readonly instructions: string;
	readonly role: AgentRole;
};

export const isAgentId = (value: unknown): value is AgentId =>
	typeof value === "string" &&
	value.length > 0 &&
	value.length <= MAX_AGENT_ID_LENGTH &&
	AGENT_ID_PATTERN.test(value);

export const isAgentRole = (value: unknown): value is AgentRole =>
	typeof value === "string" &&
	(AGENT_ROLES as readonly string[]).includes(value);
