import type { AgentId } from "@wincode/agent-core";
import type { McpAgentPolicy, McpCatalogSnapshot } from "./registry";
import type { McpToolExecutor } from "./result";

/**
 * The MCP capability one Agent Turn runs with: the snapshot it composes for an
 * Agent, the execution its tools dispatch through, and the release that ends a
 * snapshot's leases. It is what a Session Host consumes, so it names no React
 * context: the TUI's provider and a bare MCP registry both satisfy it.
 */
export type McpSessionCapability = Readonly<{
	createSnapshot: (
		agent: AgentId,
		agentPolicy?: McpAgentPolicy,
		trackLatest?: boolean
	) => Promise<McpCatalogSnapshot>;
	execute?: McpToolExecutor;
	releaseSnapshot?: (snapshot: McpCatalogSnapshot) => void;
}>;
