# MCP in coding-agent

The MCP domain runtime lives in the standalone `@wincode/mcp` package. This directory contains coding-agent-specific integration only:

- `plugins/mcp/` creates the process-owned registry resource, adapts Wincode `ConfigStore` configuration and Agent policy, and registers MCP tools in the application Plugin registry.
- `modules/mcp/capability.ts` exposes the registry to Session Hosts without leaking the package's lifecycle into React components.
- `modules/mcp/context/` provides the UI-facing MCP resource context.
- `modules/mcp/ui/` renders MCP server status and controls.

The adapter applies the existing Tool Gate before `McpRegistry.execute`. Registry membership is not authorization; the package's server policy and the injected Agent decision are inputs to that gate. See `packages/mcp/README.md` for the package contract and ownership boundary.
