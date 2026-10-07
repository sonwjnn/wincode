import type { ToolCallOutput } from "@wincode/agent-core";
import { createMcpRegistry, type McpRegistryDeps } from "@wincode/mcp";
import { omitUndefined } from "@wincode/utils";
import {
	createMcpSessionCapability,
	type McpPluginResource,
} from "@/modules/mcp/capability";
import { createWincodeMcpConfigLoader } from "@/modules/mcp/config";
import { withBundledToolName } from "@/modules/plugins/bundled-tools";
import type { PluginFactory } from "@/modules/plugins/public";
import type { ConfigStore } from "@/shared/config/config-store";

export type McpPluginResourceDependencies = Omit<
	McpRegistryDeps,
	"loadConfig"
> &
	Readonly<{
		configRoot?: string;
		configStore?: ConfigStore;
		fs?: { readFile(path: string): Promise<string> };
		homeRoot?: string;
	}>;

/** Creates and owns the configured MCP Servers used by one application runtime. */
export const createMcpPluginResource = (
	dependencies: McpPluginResourceDependencies
): McpPluginResource => {
	const {
		configRoot,
		configStore,
		createClient,
		env,
		fs,
		homeRoot,
		workspace,
	} = dependencies;
	const registry = createMcpRegistry({
		...omitUndefined({ createClient, env }),
		loadConfig: createWincodeMcpConfigLoader(
			omitUndefined({ configRoot, configStore, fs, homeRoot })
		),
		workspace,
	});
	return Object.freeze({
		capability: Object.freeze(createMcpSessionCapability(registry)),
		close: () => registry.close(),
		initialize: () => registry.initialize(),
		registry,
	});
};

const failure = (errorText: string): ToolCallOutput => ({
	errorText,
	type: "failure",
});

/** Creates the MCP Plugin; the Plugin owns its registry and turn snapshots. */
export const createMcpPluginFactory =
	(resource: McpPluginResource): PluginFactory =>
	async (api) => {
		const plugin = api.definePlugin({ id: "mcp" });
		plugin.registerResource("runtime", resource);
		plugin.onShutdown(() => resource.close());
		await resource.initialize();
		plugin.onBeforeAgentTurn(async (context, registration) => {
			const policy = await context.getAgentPermissionPolicy?.();
			if (policy === undefined) {
				return;
			}
			const snapshot = await resource.capability.createSnapshot(
				context.agentId,
				policy
			);
			context.registerTurnCleanup?.(() =>
				resource.capability.releaseSnapshot?.(snapshot)
			);
			for (const entry of snapshot.manifest) {
				const tool = snapshot.tools.get(entry.name);
				if (tool === undefined) {
					continue;
				}
				registration.registerTool(
					withBundledToolName(
						{
							description: entry.description,
							inputSchema: { jsonSchema: entry.inputSchema },
							name: entry.name,
							permissionAction: tool.logicalName,
							permissionDecision: tool.serverDecision,
							permissionResource: "*",
							permissionSafety: tool.safety,
							handler: async (input, toolContext) => {
								const execute = resource.capability.executeToolCall;
								if (execute === undefined) {
									return failure("MCP execution is unavailable.");
								}
								return execute(snapshot, entry.name, input, toolContext.signal);
							},
						},
						entry.name
					)
				);
			}
		});
	};
