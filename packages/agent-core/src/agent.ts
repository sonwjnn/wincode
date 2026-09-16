import { isNonEmptyString, isString } from "@wincode/runtime-utils";
import { z } from "zod";
import type { AgentId } from "./identifiers";

export type { AgentId } from "./identifiers";
export const MAX_AGENT_ID_LENGTH = 64;
export const MAX_AGENT_INSTRUCTIONS_LENGTH = 12_000;
export const AGENT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const AGENT_ROLES = ["primary", "subagent", "all"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];
export const agentRoleSchema = z.enum(AGENT_ROLES);

/** Canonical lowercase kebab-case Agent identity (1-64 characters). */
export const agentIdSchema = z
	.string()
	.min(1)
	.max(MAX_AGENT_ID_LENGTH)
	.regex(AGENT_ID_PATTERN)
	.transform((value): AgentId => value as AgentId);

/** A named Agent definition supplied by Wincode or the application. */
export type AgentDefinition = Readonly<{
	description: string;
	displayName: string;
	id: AgentId;
	instructions: string;
	role: AgentRole;
}>;

/**
 * The resolved Agent an Agent Turn runs as: the identity, role eligibility,
 * and literal system instructions for one turn. Configured origins, model
 * pins, and permission policy stay with the composition root that resolves
 * the Agent.
 */
export type ResolvedAgent = Readonly<{
	description?: string;
	displayName?: string;
	id: AgentId;
	instructions: string;
	role: AgentRole;
}>;

export const isAgentId = (value: unknown): value is AgentId =>
	isNonEmptyString(value) &&
	value.length <= MAX_AGENT_ID_LENGTH &&
	AGENT_ID_PATTERN.test(value);

export const isAgentRole = (value: unknown): value is AgentRole =>
	isString(value) && (AGENT_ROLES as readonly string[]).includes(value);
