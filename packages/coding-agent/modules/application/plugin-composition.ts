import { createMcpPluginFactory } from "@wincode/mcp/plugin";
import { subagentsPluginFactory } from "@wincode/subagents/plugin";
import { createMcpSecretStore } from "@/modules/mcp/mcp-secret-store";
import type { PluginPackageReference } from "@/modules/plugins/loader";
import type { PluginRuntime } from "@/modules/plugins/runtime";
import {
	createTurnToolRegistry,
	type TurnToolResolver,
} from "@/modules/sessions/hooks/runtime-turn";
import type { SessionServices } from "@/modules/sessions/host/session-services";
import { openSessionServices } from "@/modules/sessions/host/session-services";
import type { ConfigRuntime } from "@/shared/config/config-store";

// Bundled factories keep default Plugins available in standalone executables.
const DISTRIBUTED_PLUGINS: readonly PluginPackageReference[] = Object.freeze([
	{
		factory: createMcpPluginFactory({
			createSecretStore: createMcpSecretStore,
		}),
		id: "mcp",
		specifier: "@wincode/mcp/plugin",
	},
	{
		factory: subagentsPluginFactory,
		id: "subagents",
		specifier: "@wincode/subagents/plugin",
	},
]);

export type ApplicationPluginComposition = Readonly<{
	distributionPlugins: readonly PluginPackageReference[];
	turnToolResolver: TurnToolResolver;
}>;

/** Selects the distribution's default Plugins and wires their host-owned capabilities. */
export const createApplicationPluginComposition =
	(): ApplicationPluginComposition => ({
		distributionPlugins: DISTRIBUTED_PLUGINS,
		turnToolResolver: createTurnToolRegistry().resolve,
	});

export type ApplicationSessionServicesInput = Readonly<{
	configRuntime?: ConfigRuntime;
	cwd: string;
	disabledPluginIds?: readonly string[];
	pluginPaths?: readonly string[];
	pluginRuntime?: PluginRuntime;
	workspace: string;
}>;

/**
 * Opens the Session Services a non-Interactive Execution Mode runs on: the
 * distribution's Plugin packages, the invocation's Plugin selection, and the
 * application's turn tool registry, composed through the one Session
 * Services factory. Interactive Mode composes its own Session Services from the
 * providers it already holds instead.
 */
export const openApplicationSessionServices = async ({
	configRuntime,
	cwd,
	disabledPluginIds = [],
	pluginPaths = [],
	pluginRuntime,
	workspace,
}: ApplicationSessionServicesInput): Promise<SessionServices> => {
	const composition = createApplicationPluginComposition();
	return await openSessionServices({
		policy: {
			cwd,
			plugins: {
				disabledIdentifiers: disabledPluginIds,
				distributionPackages: composition.distributionPlugins,
				paths: pluginPaths,
			},
			workspace,
		},
		sources: {
			...(configRuntime === undefined
				? {}
				: { configRuntime: () => configRuntime }),
			...(pluginRuntime === undefined
				? {}
				: { pluginRuntime: () => pluginRuntime }),
			turnToolResolver: () => composition.turnToolResolver,
		},
	});
};
