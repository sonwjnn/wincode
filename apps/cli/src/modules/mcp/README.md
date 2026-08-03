# MCP (Model Context Protocol)

Runtime for connecting the coding agent to external MCP tool servers. Owns configuration
discovery, client lifecycle, catalog snapshots, execution, tool-call approval, and the status
surface. Tool execution always happens on the CLI in the user's working directory — the server
never runs file-system tools.

## Public API

- `createMcpRegistry(deps)` — build the MCP registry for a workspace. Loads config, connects
  servers, exposes `createSnapshot(mode)`, `execute(...)`, `reconnect(serverName)`,
  `getStatuses()`, `subscribe(listener)`, and `close()`.
- `McpProvider` / `useMcp()` — React context provider that owns a single registry per provider
  tree and exposes `statuses`, `createSnapshot(mode)`, `handleDynamicToolCall(...)`,
  `reconnect(serverName)`, and `close()`. The registry is created once and closed on unmount.
- Types: `McpServerStatus`, `McpApprovalRequest`, `McpCatalogSnapshot`, `McpSnapshotTool`,
  `McpExecutionPolicy`.
- `McpStatusDialogContent` — the pure status surface (list of servers, transport, state, tool
  counts, reconnectable rows). Rendered from `McpServerStatus` only, so no config, env, headers,
  or URLs can appear.

The approval dialog UI is module-internal and intentionally not part of the public entrypoint.

## Config sources

Server configuration comes from `mcp.servers` in `opencode.json` / `opencode.jsonc`, read from
two scopes and merged (project overrides global):

- Global: `~/.config/opencode/opencode.json` (or `.jsonc`).
- Project: `<workspace>/opencode.json` (or `.jsonc`).

Values of the form `{env:VAR_NAME}` are resolved from the process environment. Each server is
either `local` (spawn a `command` in a `cwd` with an optional `environment`) or `remote`
(`url` with optional `headers`). Per-phase timeouts (`startup`, `catalog`, `execution`) and a
`disabled` flag are supported. Invalid servers are dropped with diagnostics; they are never
executed.

## `.wincode/mcp.json`

Execution policy per server lives in `<workspace>/.wincode/mcp.json`:

```json
{
  "servers": {
    "github": "allow",
    "company-intranet": "ask",
    "mailgun": "deny"
  }
}
```

Unknown or unset servers default to `ask`. Malformed policy files degrade to an empty policy
with a diagnostic. The policy is read once at registry init and applies per snapshot.

## Build/Plan semantics

- **Build** mode produces a full catalog snapshot of connected servers' tools; `deny`-policy
  tools are hidden from the model.
- **Plan** mode produces an empty snapshot — MCP tools are never surfaced or executed in read-only
  planning.

## Tool-call handling

`handleDynamicToolCall(snapshot, toolCall, addToolOutput)` resolves one dynamic MCP tool call:

1. Missing or stale snapshot -> `output-error`: "MCP tool call has no active catalog".
2. `deny` policy -> `output-error` without execution.
3. `ask` policy -> opens the approval dialog (`Allow once` / `Deny`); denied or cancelled calls
   become `output-error` without execution.
4. Otherwise executes through the registry and emits a normalized result or a stable, sanitized
   error. No config, credentials, headers, URL, or command ever reach tool output.

The provider never awaits an AI SDK `onToolCall` synchronously — calls are scheduled so tool
execution cannot deadlock the chat executor.

## Local-command trust warning

A `local` server runs an arbitrary command from your configuration in your working directory with
the configured environment. Only configure local servers you trust. Commands are started at
snapshot creation; keep the allowed set small and prefer remote servers or `deny`/`ask` policy for
anything unexpected.

## Deferred surfaces

Not yet implemented (tracked in later tasks):

- MCP **resources** and **prompts** (only `tools/list` and `tools/call` are used today).
- **OAuth** for remote servers (config with `oauth` other than `false` is rejected).
- Legacy **SSE** transport (only streamable HTTP is supported).
- **Config editing** UI (`.wincode/mcp.json` and `opencode.json` are edited by hand).
