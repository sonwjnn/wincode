# MCP (Model Context Protocol)

Runtime for connecting the coding agent to external MCP tool servers. Resolves the MCP section of
the shared Wincode config snapshot and owns its schema, client lifecycle, catalog snapshots,
execution, tool-call approval, and status surface. Tool execution always happens on the CLI in the
user's working directory — the server never runs file-system tools.

## Public API

- `createMcpRegistry(deps)` — build the MCP registry for a workspace. Loads config, connects
	servers, exposes `createSnapshot(mode, agentPolicy?)`, `execute(...)`, `reconnect(serverName)`,
	`toggle(serverName)`, `getStatuses()`, `subscribe(listener)`, and `close()`.
- `McpProvider` / `useMcp()` — React context provider that owns a single registry per provider
	tree and exposes `statuses`, `createSnapshot(mode, agentPolicy?)`,
	`handleDynamicToolCall(snapshot, toolCall, addToolOutput, gate)`, `reconnect(serverName)`, and
	`toggle(serverName)`, and `close()`. The registry is created once and closed on unmount.
- Types: `McpServerStatus`, `McpApprovalRequest`, `McpCatalogSnapshot`, `McpSnapshotTool`,
  `McpAgentPolicy`, `McpApprovalGate`, `McpApprovalDecision`, `McpExecutionPolicy`.
- `McpStatusDialogContent` — the `/mcps` runtime status surface. Arrow keys navigate servers and
	Space enables or disables the highlighted server without editing configuration. Rendered from
	`McpServerStatus` only, so no config, env, headers, or URLs can appear.

MCP tools resolve approvals through the same generic Permission engine, approval queue, and
approval dialog as static coding tools — there is no MCP-specific approval controller or dialog.
The caller (the chat tool-call handler) supplies an `McpApprovalGate` that owns that shared
machinery; the registry and provider only apply the composed decision.

## Config sources

Server configuration comes from the flat `mcp` map in `wincode.json` / `wincode.jsonc`. Sources
are merged in this order, with later sources overriding earlier ones:

1. `${XDG_CONFIG_HOME:-~/.config}/wincode/wincode.json` (or `.jsonc`).
2. `~/.wincode/wincode.json` (or `.jsonc`).
3. Each directory from the Git root through `<workspace>`, in ascending precedence:
   `<directory>/wincode.json` then `<directory>/.wincode/wincode.json` (or `.jsonc`).

At one location, `.jsonc` wins when both formats exist and emits a duplicate-config diagnostic.
The process-level shared config store loads each workspace once. Objects merge recursively while
arrays and scalar values replace earlier values; later sources win and retain field-level
provenance. A malformed higher-precedence value is not skipped, so it cannot silently resurrect
lower server configuration. Config changes require restarting the CLI.

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": true,
      "permission": "ask"
    }
  }
}
```

Values of the form `{env:VAR_NAME}` are resolved from the process environment. Each server is
either `local` (spawn a `command` in a `cwd` with an optional `environment`) or `remote`
(`url` with optional `headers`). Per-phase timeouts (`startup`, `catalog`, `execution`) and a
public `enabled` flag are supported. Invalid servers are dropped with diagnostics; they are never
executed.

## Execution policy

Each server accepts `permission: "allow" | "ask" | "deny"`; missing permission defaults to
`ask`. `enabled: false` prevents connection or local process startup.

Every tool's effective decision is the **composition** of two independent sources, taken
most-restrictively (`deny` over `ask` over `allow`) so neither side can loosen the other:

1. The active **Agent** policy, evaluated against the tool's logical
   `<sanitizedServer>_<sanitizedTool>` name as an open-glob action (last-match-wins, defaulting to
   `allow` when no rule matches). This is the same Permission-rule shape static coding tools use.
2. The **server**'s own `permission`.

When the governing Agent runs under the manual-only safety ceiling, any non-`deny` composed
decision is raised to `ask`, so malformed configuration can never auto-run an MCP tool. A `deny`
from either source is always preserved.

Permission rules target the stable logical name; the collision-resistant hashed name
(`mcp_<server>_<tool>_<digest>`) remains the only dispatch identity used to actually execute a
tool.

## Build/Plan semantics

Catalog contents are purely policy-driven — neither mode is special-cased:

- **Build** connects servers and produces a catalog; a tool whose composed decision is `deny` is
  hidden from the model but kept in the dispatch map so a stray call fails closed with a policy
  denial rather than an unknown-tool error.
- **Plan** connects the same way, but its shipped baseline policy denies every open-glob action
  (`"*": "deny"`), so a default Plan exposes and executes no MCP tools. A higher-precedence policy
  that explicitly overrides that rule can re-enable specific tools, since the rule composes like
  any other.

## Tool-call handling

`handleDynamicToolCall(snapshot, toolCall, addToolOutput, gate)` resolves one dynamic MCP tool
call:

1. Missing or stale snapshot -> `output-error`: "MCP tool call has no active catalog".
2. The `gate` resolves the composed decision through the shared approval machinery (temporary
   grants, auto approval, and — for an `ask` — the shared approval dialog):
   - `deny` -> `output-error` without execution.
   - `reject` -> `output-error` carrying the optional bounded correction feedback.
   - `allow` -> executes through the registry and emits a normalized result or a stable, sanitized
     error. No config, credentials, headers, URL, or command ever reach tool output.

The provider never awaits an AI SDK `onToolCall` synchronously — calls are scheduled so tool
execution cannot deadlock the chat executor.

## Local-command trust warning

A `local` server runs an arbitrary command from your configuration in your working directory with
the configured environment. Only configure local servers you trust. Commands are started at
snapshot creation even when permission is `deny`; use `enabled: false` to prevent startup.

## Deferred surfaces

Not yet implemented (tracked in later tasks):

- MCP **resources** and **prompts** (only `tools/list` and `tools/call` are used today).
- **OAuth** for remote servers (config with `oauth` other than `false` is rejected).
- Legacy **SSE** transport (only streamable HTTP is supported).
- **Config editing** UI (`wincode.json` is edited by hand).
