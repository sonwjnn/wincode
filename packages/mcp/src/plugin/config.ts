import type { PluginConfigReader } from "@wincode/coding-agent";
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
	(config: PluginConfigReader): McpConfigLoader =>
	async ({ env, refresh, workspace }): Promise<McpConfigResult> => {
		const snapshot = await (refresh
			? config.refreshSnapshot()
			: config.getSnapshot());
		return resolveMcpConfig({ env: { ...env }, snapshot, workspace });
	};
