# `@wincode/mcp`

MCP domain runtime and optional Wincode Plugin. The package root exports the application-agnostic registry, server configuration, identity, and result contracts. `@wincode/mcp/plugin` exports the Plugin factory selected by the Wincode distribution.

## Owns

- MCP configuration schema, validation, and server configuration resolution.
- The public CLI-management API for listing, adding, removing, and authenticating MCP servers.
- MCP client adapters and server lifecycle, discovery, reconnection, and status.
- Collision-resistant tool dispatch identities, manifest limits, and result sanitization.
- The MCP Plugin factory, per-Turn tool registration, status panel, and `/mcps` command.

## Configuration

General settings and MCP server definitions are separate namespaces:

- User settings: `~/.wincode/settings.json` or `settings.jsonc`.
- User MCP servers: `~/.wincode/mcp.json`.
- Trusted project MCP servers: `<project>/.wincode/mcp.json`.

`mcp.json` contains a top-level `mcpServers` object. Local entries use a command plus optional arguments, environment, and working directory. Remote entries use an absolute HTTP(S) URL and optional headers. Wincode supports stdio and Streamable HTTP; legacy SSE is not supported.

```json
{
  "mcpServers": {
    "local-tools": {
      "command": "bun",
      "args": ["run", "./mcp-server.ts"],
      "env": { "API_TOKEN": "$MCP_API_TOKEN" }
    },
    "remote-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer $MCP_API_TOKEN" }
    }
  }
}
```

Pi-style `$NAME`, `${NAME}`, and `$env:NAME` references are expanded from the process environment. `$$` and `$!` escape a literal dollar sign and exclamation mark. A leading `!` in an `env` or `headers` value runs a shell command and uses its trimmed standard output; command execution is time-limited and output-bounded. Keep secret values in environment variables or Wincode's user-scoped secret storage, never in project files.

Trusted project definitions can configure local commands, remote endpoints, and headers. A project definition replaces the user definition for that server rather than inheriting its credentials. A project may overlay only `enabled`, `exposure`, and `toolExposure` on a user-defined server. Project MCP configuration is omitted unless the project root has been trusted. Trust is not a sandbox: trusted local MCP processes run with Wincode's operating-system privileges.

Plugin-owned MCP registrations enter the same managed catalog with Plugin provenance. File-configured servers take precedence on name conflicts, which are diagnosed.

## Public management API

The package root exports `createMcpManagement`. Its `list`, `add`, `remove`, `login`, and `logout` operations own MCP configuration semantics, including the Pi-compatible `mcpServers` shape, validation, scope precedence, resolution, and diagnostics. The Coding-Agent CLI adapter supplies a namespace-scoped config reader/writer, the process environment and workspace, a host-owned write-authorization callback, and a user-scoped `PluginSecretStore` for OAuth operations.

The API does not read or write files, resolve paths, decide whether a project is trusted, or create a secret store. Hosts provide those capabilities; the MCP package interprets only the MCP namespace. The CLI calls this API before starting the TUI or loading any Plugin runtime.

## Public Plugin boundary

The MCP Plugin imports only public contracts from `@wincode/coding-agent`. It reads the host's generic namespace-scoped config snapshot for `mcp`, interprets the `mcpServers` data itself, and registers tools and status contributions through the generic Plugin API. Coding-Agent does not import MCP registry types or own MCP-specific UI.

Application entry points select `@wincode/mcp/plugin` by default as a distribution package. SDK callers select its resolved file path explicitly with `pluginPaths`. A missing selected distribution package is reported as an installation error and can be disabled with `--no-plugin mcp`.

Discovered tools marked hidden are omitted from the model-visible catalog and cannot be dispatched. Directly exposed MCP resources are available through the resource tools. Tool exposure controls visibility, not authorization; the host's Tool Gate remains a separate policy boundary. Use OS-level isolation when stronger process containment is required.
