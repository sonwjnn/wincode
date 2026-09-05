import type {
	AgentDefinition,
	AgentId,
	ResolvedAgent,
} from "@wincode/agent-core";
import type { CodingToolName } from "@wincode/coding-tools";

export type CliAgentDefinition = AgentDefinition & {
	readonly visibleCodingTools: readonly CodingToolName[];
};

export type ResolvedCodingAgent = ResolvedAgent & {
	readonly visibleCodingTools: readonly CodingToolName[];
};

export const buildAgent = {
	description: "Implement changes with read and write access.",
	displayName: "Build",
	id: "build",
	instructions: `Mode: BUILD.
Purpose: implement requested code changes in the workspace.
Use tools to inspect and modify files before answering about code.
Prefer glob, grep, and read before editing. Use edit for targeted changes to existing files. Use write for new files or intentional complete rewrites.`,
	role: "primary",
	visibleCodingTools: ["read", "write", "edit", "glob", "grep"],
} as const satisfies CliAgentDefinition;

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
	visibleCodingTools: ["read", "glob", "grep"],
} as const satisfies CliAgentDefinition;

export const builtInAgents = [buildAgent, planAgent] as const;
export type BuiltInAgentId = (typeof builtInAgents)[number]["id"];
export type BuiltInAgentDefinition = (typeof builtInAgents)[number];

export const DEFAULT_AGENT_ID: AgentId = buildAgent.id;
