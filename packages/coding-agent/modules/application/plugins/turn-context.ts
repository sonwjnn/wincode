import type { AgentId, AgentTurnId } from "@wincode/agent-core";
import type { ChatModelSelection, ThinkingLevel } from "@wincode/ai/models";
import type {
	PluginRuntime,
	PluginToolDescriptor,
} from "@/modules/plugins/runtime";
import type {
	SessionSdkCapabilityCeiling,
	SessionSdkOperations,
} from "@/modules/sessions/sdk-contract";
import type { SkillExecution, SkillToolDefinition } from "@/modules/skills";
import type {
	CodingToolName,
	ToolResourceLimits,
	VersionedEditingContext,
} from "@/modules/tools";
import type { SessionId } from "@/shared/identifiers";

/** Per-Agent-Turn inputs shared with built-in Plugin tool providers. */
export type TurnToolPluginContext = Readonly<{
	agentId?: AgentId;
	/** Optional tool ceiling inherited by child Sessions delegated from this Agent. */
	capabilityCeiling?: SessionSdkCapabilityCeiling;
	model?: ChatModelSelection;
	thinkingLevel?: ThinkingLevel;
	turnId?: AgentTurnId;
	/** Tools explicitly selected for this Agent. */
	agentTools: readonly CodingToolName[];
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
	sessionSdk?: SessionSdkOperations;
}>;

export type CodingToolProviderContext = Pick<
	TurnToolPluginContext,
	"agentTools" | "resourceLimits" | "versionedEditing"
>;
export type ShellToolProviderContext = CodingToolProviderContext;
export type SkillToolProviderContext = Pick<
	TurnToolPluginContext,
	"skillExecution" | "skillTool"
>;
export type PluginToolProviderContext = Pick<
	TurnToolPluginContext,
	| "agentId"
	| "existingToolNames"
	| "pluginTools"
	| "pluginRuntime"
	| "sessionId"
	| "signal"
	| "workspace"
>;
