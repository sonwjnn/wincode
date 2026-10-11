import type {
	PluginConfigFileStore,
	PluginMcpServerRegistration,
} from "@wincode/coding-agent";
import type { McpConfigLoader, McpConfigResult } from "../config";
import { resolveMcpConfig } from "../config";

export type {
	InvalidMcpServerConfig,
	McpConfigDiagnostic,
	McpConfigResult,
	ResolvedMcpServerConfig,
} from "../config";

/** Adapts MCP's configuration interpretation to the host's merged snapshot. */
export const createMcpConfigLoader =
	(
		configFiles: PluginConfigFileStore,
		getMcpServerRegistrations: () => readonly PluginMcpServerRegistration[] = () => []
	): McpConfigLoader =>
	async ({ env, refresh, workspace }): Promise<McpConfigResult> => {
		const snapshot = await (refresh
			? configFiles.refreshSnapshot("mcp")
			: configFiles.getSnapshot("mcp"));
		const registrationSources = getMcpServerRegistrations().map(
			({ config, name, ownerPluginId }) => ({
				document: { mcpServers: { [name]: config } },
				path: `plugin:${ownerPluginId}`,
				scope: "plugin",
			})
		);
		return resolveMcpConfig({
			env: { ...env },
			snapshot: {
				...snapshot,
				sources: [...registrationSources, ...snapshot.sources],
			},
			workspace,
		});
	};
