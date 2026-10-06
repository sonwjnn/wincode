import type { Plugin } from "@/modules/application/plugins/registry";
import {
	createDisabledMcpPluginResource,
	type McpPluginResource,
} from "@/modules/mcp/capability";
import {
	createTurnToolRegistry,
	type TurnToolPluginContext,
	type TurnToolResolver,
} from "@/modules/sessions/hooks/runtime-turn";
import type {
	SessionCapabilities,
	SessionDelegationAdapter,
	SessionDelegationRuntimeFactory,
} from "@/modules/sessions/host/types";
import { mcpPlugin } from "@/plugins/mcp";
import { subagentsPlugin } from "@/plugins/subagents";
import {
	createDelegationExecutor,
	createSubmitResultExecutor,
	failDelegatedTask,
	hasDelegationTargets,
	settleDelegatedTaskAfterTurn,
} from "@/plugins/subagents/delegation";
import { createSubagentTaskRuntime } from "@/plugins/subagents/task-runtime";
import type { ConfigStore } from "@/shared/config/config-store";
import { createConfigStore } from "@/shared/config/config-store";

export type OptionalApplicationPluginId = "mcp" | "subagents";

const optionalApplicationPluginIds: readonly OptionalApplicationPluginId[] = [
	"mcp",
	"subagents",
];

export const selectOptionalApplicationPlugins = (
	disabled: readonly OptionalApplicationPluginId[] = []
): readonly OptionalApplicationPluginId[] =>
	optionalApplicationPluginIds.filter(
		(pluginId) => !disabled.includes(pluginId)
	);

export type ApplicationPluginComposition = Readonly<{
	createDelegationAdapter?: (
		capabilities: SessionCapabilities
	) => SessionDelegationAdapter;
	createDelegationRuntime?: SessionDelegationRuntimeFactory;
	mcpResource?: McpPluginResource;
	turnToolResolver: TurnToolResolver;
}>;

export type CreateApplicationPluginCompositionOptions = Readonly<{
	configStore?: ConfigStore;
	enabledPlugins: readonly OptionalApplicationPluginId[];
	createMcpResource?: boolean;
	mcpResource?: McpPluginResource;
	workspace: string;
}>;

const createDelegationAdapter = (
	capabilities: SessionCapabilities
): SessionDelegationAdapter => ({
	createExecutor: ({ execution, executionMode, sessionId }) =>
		createDelegationExecutor({
			capabilities,
			execution,
			...(executionMode === undefined ? {} : { executionMode }),
			sessionId,
		}),
	createSubmitResultExecutor: (taskId) =>
		createSubmitResultExecutor(capabilities, taskId),
	failTask: (taskId, error) => failDelegatedTask(capabilities, taskId, error),
	hasTargets: () => hasDelegationTargets(capabilities),
	settleAfterTurn: (task, event) =>
		settleDelegatedTaskAfterTurn(capabilities, task, event),
});

/** Selects optional bundled Plugins outside the Session core. */
export const createApplicationPluginComposition = ({
	configStore = createConfigStore(),
	createMcpResource = true,
	enabledPlugins,
	mcpResource: providedMcpResource,
	workspace,
}: CreateApplicationPluginCompositionOptions): ApplicationPluginComposition => {
	const selectedPlugins: Plugin<TurnToolPluginContext>[] = [];
	let mcpResource =
		providedMcpResource ??
		(enabledPlugins.includes("mcp")
			? undefined
			: createDisabledMcpPluginResource());
	if (enabledPlugins.includes("mcp")) {
		if (mcpResource === undefined && createMcpResource) {
			mcpResource = mcpPlugin.createResource({ configStore, workspace });
		}
		selectedPlugins.push(mcpPlugin);
	}
	if (enabledPlugins.includes("subagents")) {
		selectedPlugins.push(subagentsPlugin);
	}
	const registry = createTurnToolRegistry(selectedPlugins);
	return {
		...(mcpResource === undefined ? {} : { mcpResource }),
		...(enabledPlugins.includes("subagents")
			? {
					createDelegationAdapter,
					createDelegationRuntime: createSubagentTaskRuntime,
				}
			: {}),
		turnToolResolver: registry.resolve,
	};
};
