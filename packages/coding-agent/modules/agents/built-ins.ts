import {
	type AgentDefinition,
	type AgentId,
	agentIdSchema,
	type ResolvedAgent,
} from "@wincode/agent-core";
import type { CodingToolName } from "@/modules/tools";

export type CliAgentDefinition = AgentDefinition & {
	readonly visibleCodingTools: readonly CodingToolName[];
};

export type ResolvedCodingAgent = ResolvedAgent & {
	readonly requiresManualApproval?: boolean;
	readonly visibleCodingTools: readonly CodingToolName[];
};

const BUILD_AGENT_ID = agentIdSchema.parse("build");
export const buildAgent = {
	description: "Implement changes with read and write access.",
	displayName: "Build",
	id: BUILD_AGENT_ID,
	instructions: `Mode: BUILD.
Purpose: implement requested code changes in the workspace.
Use tools to inspect and modify files before answering about code.
Prefer glob, grep, and read before editing. Use edit for targeted changes to existing files. Use write for new files or intentional complete rewrites.`,
	role: "primary",
	visibleCodingTools: ["read", "write", "edit", "recover", "glob", "grep"],
} as const satisfies CliAgentDefinition;

export const builtInAgents = [buildAgent] as const;
export type BuiltInAgentId = (typeof builtInAgents)[number]["id"];
export type BuiltInAgentDefinition = (typeof builtInAgents)[number];

export const DEFAULT_AGENT_ID: AgentId = buildAgent.id;
