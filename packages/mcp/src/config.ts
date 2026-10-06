import type { McpConfigResult } from "./config/resolve";

export {
	type InvalidMcpServerConfig,
	type McpConfigDiagnostic,
	type McpConfigDiagnosticCode,
	type McpConfigOrigin,
	type McpConfigResult,
	type McpConfigSnapshot,
	type McpConfigSource,
	resolveServers as resolveMcpConfig,
} from "./config/resolve";
export {
	DEFAULT_MCP_TIMEOUTS,
	type LocalMcpServerConfig,
	type McpTimeouts,
	type RemoteMcpServerConfig,
	type ResolvedMcpServerConfig,
} from "./config/schema";

/** Inputs the application supplies when the MCP runtime loads its config. */
export type McpConfigLoadRequest = Readonly<{
	env: Readonly<Record<string, string | undefined>>;
	refresh: boolean;
	workspace: string;
}>;

/** Application-owned source for Wincode configuration snapshots. */
export type McpConfigLoader = (
	request: McpConfigLoadRequest
) => Promise<McpConfigResult>;
