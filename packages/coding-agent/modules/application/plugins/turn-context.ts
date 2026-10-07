import type { AgentId, AgentTurnId } from "@wincode/agent-core";
import type {
	ChatModelSelection,
	Effort,
	ReasoningMode,
} from "@wincode/ai/models";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
import type { PluginPermissionResolution } from "@/modules/plugins/tools";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkChildFactory,
} from "@/modules/sessions/sdk-contract";
import type { SkillExecution, SkillToolDefinition } from "@/modules/skills";
import type { ToolGate } from "@/modules/tool-gate/tool-gate";
import type {
	CodingToolName,
	ToolResourceLimits,
	VersionedEditingContext,
} from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";

/** Per-Agent-Turn inputs shared with built-in Plugin tool providers. */
export type TurnToolPluginContext = Readonly<{
	/** The resolved Agent identity used for policy evaluation. */
	agentId?: AgentId;
	/** Optional tool ceiling inherited by child Sessions delegated from this Agent. */
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	effort?: Effort;
	model?: ChatModelSelection;
	reasoningMode?: ReasoningMode;
	turnId?: AgentTurnId;
	/** Tools selected for this Agent after Agent permissions are resolved. */
	agentTools: readonly CodingToolName[];
	gate: ToolGate;
	resolveResourceLimits?: (agentId?: AgentId) => Promise<ToolResourceLimits>;
	/** Resource-profile snapshot used to shape model-facing tool schemas. */
	resourceLimits?: ToolResourceLimits;
	skillExecution?: SkillExecution;
	skillTool?: SkillToolDefinition;
	versionedEditing?: VersionedEditingContext;
	pluginRuntime?: PluginRuntime;
	pluginTools?: readonly PluginToolDescriptor[];
	registerTurnCleanup?: (cleanup: () => void) => void;
	sessionId?: SessionId;
	signal?: AbortSignal;
	workspace?: string;
	existingToolNames?: readonly string[];
	resolvePluginPermission?: (
		action: `plugin:${string}:${string}`,
		agentId?: AgentId
	) => Promise<PluginPermissionResolution>;
	resolveToolPermission?: (
		action: string,
		resource: string,
		agentId?: AgentId
	) => Promise<PluginPermissionResolution>;
	sessionSdk?: SessionSdkChildFactory;
}>;

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
	| "pluginRuntime"
	| "resolveToolPermission"
	| "sessionId"
	| "signal"
	| "workspace"
>;
