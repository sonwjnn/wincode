import type { AgentId, ToolCallOutput } from "@wincode/agent-core";
import type { McpCatalogSnapshot } from "@wincode/mcp";
import type { SubagentToolContext } from "@wincode/subagents";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
import type { PluginPermissionResolution } from "@/modules/plugins/tools";
import type { SessionSdkChildFactory } from "@/modules/sessions/sdk-contract";
import type { SkillExecution, SkillToolDefinition } from "@/modules/skills";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";
import type {
	CodingToolName,
	ToolResourceLimits,
	VersionedEditingContext,
} from "@/modules/tools";
import type { DelegationTaskId, SessionId } from "@/shared/identifiers";

/** Per-Agent-Turn inputs shared with built-in Plugin tool providers. */
export type TurnToolPluginContext = Readonly<
	SubagentToolContext<SessionId, DelegationTaskId> & {
		/** The resolved Agent identity used for policy evaluation. */
		agentId?: AgentId;
		/** Tools selected for this Agent after Agent permissions are resolved. */
		agentTools: readonly CodingToolName[];
		gate: ToolGate;
		mcpSnapshot?: McpCatalogSnapshot;
		executeMcpTool?: (
			snapshot: McpCatalogSnapshot,
			toolName: string,
			input: unknown,
			signal?: AbortSignal
		) => Promise<ToolCallOutput>;
		resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
		/** Resource-profile snapshot used to shape model-facing tool schemas. */
		resourceLimits?: ToolResourceLimits;
		skillExecution?: SkillExecution;
		skillTool?: SkillToolDefinition;
		versionedEditing?: VersionedEditingContext;
		pluginRuntime?: PluginRuntime;
		pluginTools?: readonly PluginToolDescriptor[];
		sessionId?: SessionId;
		signal?: AbortSignal;
		workspace?: string;
		existingToolNames?: readonly string[];
		resolvePluginPermission?: (
			action: `plugin:${string}:${string}`,
			agentId?: AgentId
		) => Promise<PluginPermissionResolution>;
		resolveDelegationPermission?: (
			agentId?: AgentId
		) => Promise<PluginPermissionResolution>;
		sessionSdk?: SessionSdkChildFactory;
	}
>;

export type CodingToolProviderContext = Pick<
	TurnToolPluginContext,
	| "agentId"
	| "agentTools"
	| "gate"
	| "resolveResourceLimits"
	| "resourceLimits"
	| "versionedEditing"
>;
export type ShellToolProviderContext = CodingToolProviderContext;
export type McpToolProviderContext = Pick<
	TurnToolPluginContext,
	"agentId" | "executeMcpTool" | "gate" | "mcpSnapshot"
>;
export type SkillToolProviderContext = Pick<
	TurnToolPluginContext,
	"agentId" | "gate" | "skillExecution" | "skillTool"
>;
export type PluginToolProviderContext = Pick<
	TurnToolPluginContext,
	| "agentId"
	| "existingToolNames"
	| "gate"
	| "pluginTools"
	| "resolvePluginPermission"
	| "sessionId"
	| "signal"
	| "workspace"
>;
export type SubagentsToolProviderContext = Pick<
	TurnToolPluginContext,
	| "agentId"
	| "delegate"
	| "delegationTaskId"
	| "gate"
	| "parentTurnId"
	| "resolveDelegationPermission"
	| "submitResult"
>;
