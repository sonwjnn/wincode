# `@wincode/mcp`

MCP domain runtime and optional Wincode Plugin. The package root exports the application-agnostic registry, server configuration, identity, and result contracts. `@wincode/mcp/plugin` exports the Plugin factory selected by the Wincode distribution.

## Owns

- MCP configuration schema, validation, and server configuration resolution.
- MCP client adapters and server lifecycle, discovery, reconnection, and status.
- Collision-resistant tool dispatch identities, manifest limits, and result sanitization.
- The MCP Plugin factory, per-Turn tool registration, status panel, and `/mcps` command.

## Public Plugin boundary

The MCP Plugin imports only public contracts from `@wincode/coding-agent`. It reads Wincode's merged, read-only configuration snapshot through `PluginLoadContext.config`, interprets the `mcp` section itself, and registers tools and status contributions through the generic Plugin API. Coding-Agent does not import MCP registry types or own MCP-specific UI.

Application entry points select `@wincode/mcp/plugin` by default as a distribution package. SDK callers select its resolved file path explicitly with `pluginPaths`. A missing selected distribution package is reported as an installation error and can be disabled with `--no-plugin mcp`.

Project MCP configuration is protected by Project trust. Without a saved or explicit trust decision, Wincode omits project configuration; in non-interactive modes it does not prompt or silently trust. Once trusted, project configuration may define local commands, remote endpoints, and headers. Project trust is not a sandbox: local MCP processes run with Wincode's operating-system privileges.

Discovered MCP tools are registered for Agent selection and execute without a Wincode per-call allow/ask/deny policy. Use OS-level isolation when stronger process containment is required.
