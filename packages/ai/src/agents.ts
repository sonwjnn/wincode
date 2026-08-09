import { z } from "zod";
import { type CodingToolName, codingToolNameSchema } from "./tools/schemas";

export const MAX_AGENT_ID_LENGTH = 64;
export const AGENT_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const agentIdSchema = z
	.string()
	.min(1)
	.max(MAX_AGENT_ID_LENGTH)
	.regex(AGENT_ID_REGEX);
export const agentRoleSchema = z.enum(["primary", "subagent", "all"]);

export type AgentId = z.infer<typeof agentIdSchema>;
export type AgentRole = z.infer<typeof agentRoleSchema>;

export type AgentDefinition = {
	description: string;
	displayName: string;
	id: AgentId;
	instructions: string;
	role: AgentRole;
	visibleCodingTools: readonly CodingToolName[];
};

export const buildAgent = {
	description: "Implement changes with read and write access.",
	displayName: "Build",
	id: "build",
	instructions: `Mode: BUILD.
Purpose: implement requested code changes in the workspace.
Use tools to inspect and modify files before answering about code.
Prefer list, grep, and read before editing. Prefer edit for targeted changes and write for new files or full rewrites.`,
	role: "primary",
	visibleCodingTools: ["read", "write", "edit", "list", "grep"],
} as const satisfies AgentDefinition;

export const planAgent = {
	description: "Read-only analysis and planning.",
	displayName: "Plan",
	id: "plan",
	instructions: `Mode: PLAN.
Purpose: read-only analysis and implementation planning.
Do not modify files. Do not write files. Do not call edit or write tools.
Use only read-only inspection tools to understand the workspace.
Return a concrete plan, risks, and verification steps instead of implementing changes.`,
	role: "primary",
	visibleCodingTools: ["read", "list", "grep"],
} as const satisfies AgentDefinition;

export const builtInAgents = [buildAgent, planAgent] as const;

export type BuiltInAgentId = (typeof builtInAgents)[number]["id"];
export type BuiltInAgentDefinition = (typeof builtInAgents)[number];

export const resolvedAgentRuntimeSchema = z.object({
	instructions: z.string(),
	visibleCodingTools: z.array(codingToolNameSchema),
});

export type ResolvedAgentRuntime = z.infer<typeof resolvedAgentRuntimeSchema>;
