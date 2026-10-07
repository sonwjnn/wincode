import { createDisabledMcpPluginResource } from "@/modules/mcp/capability";
import type { BundledPluginFactory } from "@/modules/plugins/loader";
import {
	createTurnToolRegistry,
	type TurnToolResolver,
} from "@/modules/sessions/hooks/runtime-turn";
import { createMcpPluginFactory, createMcpPluginResource } from "@/plugins/mcp";
import { createSubagentsPluginFactory } from "@/plugins/subagents";
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
	enabledPlugins: readonly OptionalApplicationPluginId[];
	bundledPlugins: readonly BundledPluginFactory[];
	turnToolResolver: TurnToolResolver;
}>;

export type CreateApplicationPluginCompositionOptions = Readonly<{
	configStore?: ConfigStore;
	enabledPlugins: readonly OptionalApplicationPluginId[];
	createMcpResource?: boolean;
	workspace: string;
}>;

/** Selects optional bundled Plugins outside the Session core. */
export const createApplicationPluginComposition = ({
	configStore = createConfigStore(),
	createMcpResource = true,
	enabledPlugins,
	workspace,
}: CreateApplicationPluginCompositionOptions): ApplicationPluginComposition => {
	const bundledPlugins: BundledPluginFactory[] = [];
	const mcpResource =
		enabledPlugins.includes("mcp") && createMcpResource
			? createMcpPluginResource({ configStore, workspace })
			: createDisabledMcpPluginResource();
	if (enabledPlugins.includes("mcp")) {
		bundledPlugins.push({
			factory: createMcpPluginFactory(mcpResource),
			id: "mcp",
		});
	}
	if (enabledPlugins.includes("subagents")) {
		bundledPlugins.push({
			factory: createSubagentsPluginFactory(),
			id: "subagents",
		});
	}
	const registry = createTurnToolRegistry();
	return {
		enabledPlugins: Object.freeze([...enabledPlugins]),
		bundledPlugins: Object.freeze(bundledPlugins),
		turnToolResolver: registry.resolve,
	};
};
