import type { PluginPackageReference } from "@/modules/plugins/loader";
import {
	createTurnToolRegistry,
	type TurnToolResolver,
} from "@/modules/sessions/hooks/runtime-turn";

const DISTRIBUTED_PLUGINS: readonly PluginPackageReference[] = Object.freeze([
	{ id: "mcp", specifier: "@wincode/mcp/plugin" },
	{ id: "subagents", specifier: "@wincode/subagents/plugin" },
]);

export type ApplicationPluginComposition = Readonly<{
	distributionPlugins: readonly PluginPackageReference[];
	turnToolResolver: TurnToolResolver;
}>;

/** Selects the distribution's default Plugin packages without importing them. */
export const createApplicationPluginComposition =
	(): ApplicationPluginComposition => ({
		distributionPlugins: DISTRIBUTED_PLUGINS,
		turnToolResolver: createTurnToolRegistry().resolve,
	});
