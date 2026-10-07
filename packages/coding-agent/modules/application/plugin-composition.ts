import {
	createDisabledMcpPluginResource,
	type McpPluginResource,
} from "@/modules/mcp/capability";
import type { BundledPluginFactory } from "@/modules/plugins/loader";
import {
	createTurnToolRegistry,
	type TurnToolResolver,
} from "@/modules/sessions/hooks/runtime-turn";
import type {
	SessionCapabilities,
	SessionDelegationAdapter,
	SessionDelegationRuntimeFactory,
} from "@/modules/sessions/host/types";
import { createMcpPluginResource, mcpPluginFactory } from "@/plugins/mcp";
import {
	createSubagentsSessionAdapter,
	createSubagentsSessionRuntime,
	subagentsPluginFactory,
} from "@/plugins/subagents";
import {
	getSharedSubagentsTaskStore,
	resolveSubagentsDatabasePath,
} from "@/plugins/subagents/store";
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
	bundledPlugins: readonly BundledPluginFactory[];
	turnToolResolver: TurnToolResolver;
}>;

export type CreateApplicationPluginCompositionOptions = Readonly<{
	configStore?: ConfigStore;
	enabledPlugins: readonly OptionalApplicationPluginId[];
	createMcpResource?: boolean;
	mcpResource?: McpPluginResource;
	subagentsDatabasePath?: string;
	workspace: string;
}>;

/** Selects optional bundled Plugins outside the Session core. */
export const createApplicationPluginComposition = ({
	configStore = createConfigStore(),
	createMcpResource = true,
	enabledPlugins,
	mcpResource: providedMcpResource,
	subagentsDatabasePath,
	workspace,
}: CreateApplicationPluginCompositionOptions): ApplicationPluginComposition => {
	const bundledPlugins: BundledPluginFactory[] = [];
	let mcpResource =
		providedMcpResource ??
		(enabledPlugins.includes("mcp")
			? undefined
			: createDisabledMcpPluginResource());
	if (enabledPlugins.includes("mcp")) {
		if (mcpResource === undefined && createMcpResource) {
			mcpResource = createMcpPluginResource({ configStore, workspace });
		}
		bundledPlugins.push({ factory: mcpPluginFactory, id: "mcp" });
	}
	const subagentsTaskStore = enabledPlugins.includes("subagents")
		? getSharedSubagentsTaskStore(
				subagentsDatabasePath ?? resolveSubagentsDatabasePath(workspace)
			)
		: undefined;
	if (enabledPlugins.includes("subagents")) {
		bundledPlugins.push({ factory: subagentsPluginFactory, id: "subagents" });
	}
	const registry = createTurnToolRegistry();
	return {
		...(mcpResource === undefined ? {} : { mcpResource }),
		...(subagentsTaskStore === undefined
			? {}
			: {
					createDelegationAdapter: (capabilities) =>
						createSubagentsSessionAdapter(capabilities, subagentsTaskStore),
					createDelegationRuntime: (ports) =>
						createSubagentsSessionRuntime(ports, subagentsTaskStore),
				}),
		bundledPlugins: Object.freeze(bundledPlugins),
		turnToolResolver: registry.resolve,
	};
};
