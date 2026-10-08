# `@wincode/mcp`

MCP domain runtime and optional Wincode Plugin. The package root exports the application-agnostic registry, configuration, identity, and result contracts. `@wincode/mcp/plugin` exports the Plugin factory selected by the Wincode distribution.

## Owns

- MCP configuration schema, validation, and server configuration resolution.
- MCP client adapters and server lifecycle, discovery, reconnection, and status.
- Stable logical tool identities, collision-resistant dispatch identities, and manifest limits.
- Server policy evaluation, Agent-policy composition, safety ceilings, and result sanitization.
- The MCP Plugin factory, per-Turn tool registration, status panel, and `/mcps` command.

## Public Plugin boundary

The MCP Plugin imports only public contracts from `@wincode/coding-agent`. It reads Wincode's merged, read-only configuration snapshot through `PluginLoadContext.config`, interprets the `mcp` section itself, and resolves Agent permissions through the generic action/resource callback. It registers status and controls through the generic Plugin status-panel API; Coding-Agent does not import MCP registry types or own MCP-specific UI.

Application entry points select `@wincode/mcp/plugin` by default as a distribution package. SDK callers select its resolved file path explicitly with `pluginPaths`. A missing selected distribution package is reported as an installation error and can be disabled with `--no-plugin mcp`.

Project-sourced local MCP server commands are not started automatically; configure local servers in user configuration. Project-sourced remote headers are rejected, and a project URL cannot redirect user-configured headers; configure authenticated remote endpoints and headers in user configuration. MCP permission actions use the owner-qualified `plugin:mcp:<server>_<tool>` namespace. For example, use `plugin:mcp:external_*` for the MCP action family rather than the unqualified `external_*`; remembered MCP approvals must not grant host filesystem permissions.
