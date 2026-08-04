# MCP Lifecycle and Tools

## Goal

Allow Wincode CLI users to run tools from configured local and remote MCP servers while preserving the existing execution boundary: the hosted server may describe tools to the model, but only the CLI may connect to MCP servers or execute tool calls.

This is the first slice of broader MCP support. It establishes configuration, transport lifecycle, tool discovery, model exposure, local authorization, execution, status, and failure handling.

## Success Criteria

- The CLI reads supported OpenCode v2 MCP server definitions from global and project config.
- Enabled local stdio and remote Streamable HTTP servers expose qualified tools in Build mode.
- MCP processes, credentials, headers, and URLs remain local to the CLI.
- The hosted server receives only a bounded tool manifest and registers schema-only dynamic tools.
- MCP calls are authorized and executed locally, and their results continue the existing agent loop.
- One unavailable server does not prevent CLI startup or other MCP servers from working.
- Plan mode remains read-only by omitting all MCP tools.

## Out of Scope

- MCP resources, resource templates, prompts, and server instructions.
- OAuth discovery, browser authorization, token persistence, and refresh.
- Legacy SSE transport and legacy flat OpenCode MCP config.
- MCP sampling, elicitation, roots, and task APIs.
- Automatic reconnect and filesystem config watching.
- Config creation or editing from the CLI or web app.
- Web UI and server-side MCP execution.

These capabilities require later specs. The lifecycle and catalog boundaries in this design should support adding them without moving MCP execution to the hosted server.

## Architecture

### CLI MCP module

`apps/cli/src/modules/mcp/` owns the feature:

- OpenCode config discovery, merge, validation, and environment interpolation;
- Wincode policy config parsing;
- MCP SDK transport adapters;
- connection lifecycle and status registry;
- tool discovery and catalog snapshots;
- qualified tool-name generation and local dispatch;
- authorization decisions and approval UI;
- MCP result normalization.

The module exposes a small public API for app composition and conversations. Internal transport, config, and policy files are not imported directly by consumers.

### Shared AI contracts

`packages/ai` owns only contracts that cross the CLI/server boundary:

- MCP tool manifest schemas;
- chat request extensions;
- dynamic tool-call/result message typing;
- schema-only conversion helpers used by the hosted agent.

It must not import the MCP client SDK, read MCP config, start processes, connect to endpoints, hold credentials, or execute MCP tools.

### App and server composition

`apps/cli/src/app/` creates one MCP registry for the CLI process and supplies its public API to the conversation flow. Connections are reused across chat sessions and closed deterministically on CLI shutdown.

`apps/server` validates the client manifest, accounts for its model-context cost, and supplies schema-only dynamic tools to the AI SDK agent. It never receives transport configuration or executable callbacks.

## Dependencies

Use the current stable MCP TypeScript v2 client package directly in the CLI app. Use its stdio and Streamable HTTP client transports. Do not depend on the existing indirect v1 SDK copy in the lockfile.

The CLI must spawn local commands through an argv-based transport, never a shell command string.

## Configuration

### Sources and precedence

Read two OpenCode v2 config scopes:

1. Global: `~/.config/opencode/opencode.json` or `opencode.jsonc`.
2. Project: `opencode.json` or `opencode.jsonc` at the CLI workspace root.

Global config loads first. Project `mcp.timeout` values override matching global timeout fields. Project `mcp.servers.<name>` entries merge over matching global entries by field; project-only servers are added.

At one scope, if both `.json` and `.jsonc` exist, `.jsonc` wins and the status UI reports the ignored duplicate. Parsing supports JSONC comments and trailing commas.

The first slice does not load OpenCode remote organization config, managed config, `OPENCODE_CONFIG`, or `OPENCODE_CONFIG_CONTENT`.

### Supported OpenCode v2 subset

Shared server fields:

- `disabled?: boolean`, default `false`;
- `timeout?: { startup?: number; catalog?: number; execution?: number }`.

Local server fields:

- `type: "local"`;
- `command: [string, ...string[]]`;
- `cwd?: string`, relative to the workspace root when not absolute;
- `environment?: Record<string, string>`.

Remote server fields:

- `type: "remote"`;
- `url: string`, requiring an absolute HTTP or HTTPS URL;
- `headers?: Record<string, string>`;
- `oauth?: false`.

`codemode` is accepted and ignored because Wincode exposes tools through its own mode system. An OAuth object marks that server unavailable with an unsupported-auth status; the CLI must not silently retry without authentication. Other unrelated OpenCode fields are ignored.

Timeouts must be positive integer milliseconds. Defaults follow OpenCode v2: 30 seconds for startup, 30 seconds for catalog operations, and 12 hours for execution.

### Environment interpolation

Resolve exact `{env:NAME}` placeholders in local `environment` values and remote `headers` values. Do not evaluate shell expressions or interpolate arbitrary config fields. A missing environment variable disables only that server and produces a sanitized status error naming the variable but not any secret value.

Local MCP processes inherit the CLI environment plus configured overrides, matching OpenCode behavior.

### Wincode execution policy

Project file `.wincode/mcp.json` contains Wincode-only execution policy and does not alter OpenCode's schema:

```json
{
  "servers": {
    "github": "ask",
    "context7": "allow",
    "dangerous": "deny"
  }
}
```

Allowed values are `allow`, `ask`, and `deny`. Missing server entries default to `ask`. Unknown policy entries remain visible as warnings but do not create MCP servers.

- `allow`: execute calls without a confirmation dialog in Build mode.
- `ask`: show confirmation for every call; approval applies once.
- `deny`: omit the server's tools from the model manifest.

Plan mode always omits MCP tools regardless of policy.

## Lifecycle and Catalog

Config and policy are parsed during CLI initialization, but enabled servers connect lazily when the first Build request needs a catalog or when the user requests a reconnect from MCP status UI.

The registry connects servers concurrently and isolates each result. One registry entry owns one MCP client, transport, current catalog snapshot, state, and sanitized last error. States are `idle`, `connecting`, `connected`, `degraded`, `disabled`, and `failed`.

After initialization, the client lists tools and records an immutable catalog snapshot. If the server advertises tool-list changes, the registry subscribes through the SDK and refreshes the snapshot. A refresh applies only to later chat requests. An in-flight turn retains the exact snapshot sent with that request.

Startup, catalog, and execution operations use their corresponding timeout. A process exit, transport disconnect, or timeout closes the affected client and marks it degraded or failed. Reconnection is manual in this slice. CLI shutdown closes all connected transports and child processes.

## Tool Identity

Model-visible tool names are server-qualified and never reuse raw MCP names directly. Generate names in this shape:

```text
mcp_<sanitized-server>_<sanitized-tool>_<stable-hash>
```

The result must match `^[A-Za-z0-9_-]+$` and be at most 64 characters. The stable hash derives from the unsanitized server/tool pair, so truncation and sanitization cannot create collisions. The registry retains the original server name and tool name for local dispatch.

The `mcp_` namespace prevents collisions with built-in coding tools. Duplicate generated names are a catalog error for the affected entries and must never silently overwrite a tool.

## Chat and Execution Flow

1. Before a Build chat request, the conversation flow asks the registry for a catalog snapshot.
2. The registry omits disabled, denied, unavailable, and invalid tools.
3. The CLI sends a manifest containing only qualified name, description, and input JSON Schema.
4. The hosted route validates the manifest and includes its serialized content in funded input-token accounting.
5. The hosted agent merges built-in tools with AI SDK schema-only dynamic tools.
6. The model emits a dynamic tool call. The existing stream returns it to the CLI.
7. The CLI resolves the call against the in-flight snapshot. Unknown or stale names return a tool error without execution.
8. The CLI rechecks mode and policy. `ask` opens approval UI; cancel or denial returns a tool error.
9. The registry calls the original MCP tool with the model input and execution timeout.
10. The CLI normalizes the result to bounded JSON-safe output and adds it to the chat, allowing the agent loop to continue.

The CLI must not accept server-supplied MCP configuration in a tool call. Dispatch uses only registry entries created from local config.

Historical dynamic tool parts are validated against the generic dynamic-call/result wire schema, not the current catalog. Only calls emitted during the current request may resolve against its immutable snapshot. Removing or changing a tool therefore does not invalidate conversation history and cannot make an old call executable again.

## Manifest and Result Bounds

Enforce bounds in both the CLI producer and hosted route:

- at most 128 MCP tools per request;
- at most 64 KiB serialized input schema per tool;
- at most 256 KiB for the complete serialized MCP manifest;
- at most 8 KiB UTF-8 description text per tool;
- at most 256 KiB normalized output per MCP call.

Reject an invalid or oversized manifest as a bad chat request. A catalog exceeding limits remains visible in MCP status, with excess or invalid tools excluded deterministically by server name then original tool name.

For oversized results, preserve valid text or structured content up to the limit and append explicit truncation metadata. Text and structured MCP content are retained. Binary content and resource links become bounded metadata records; raw binary payloads are not inserted into chat in this slice.

## Approval and Status UI

The approval dialog shows server name, original tool name, description, and formatted input. Actions are `Allow once` and `Deny`; escape, close, or lost focus denies the call. The dialog must not display resolved headers, environment values, or transport internals.

Add an `/mcp` command that opens a status dialog. It lists server name, transport type, lifecycle state, discovered tool count, and sanitized last error. It provides reconnect for selected unavailable servers but no config editing. Local server rows state that configured commands run with the user's OS permissions and inherited environment.

After initial catalog loading, a toast summarizes connected and failed server counts. Individual failures remain inspectable in `/mcp` rather than producing a toast storm.

## Failure Handling

- Invalid global or project MCP sections do not crash the CLI. Valid servers from the other scope remain usable, and config errors appear in MCP status.
- Failure of one server never removes tools from another server.
- A denied approval, stale tool name, invalid call input, timeout, or MCP error becomes a dynamic tool `output-error` so the model can recover.
- Error messages are sanitized before entering UI or chat. Expanded headers, environment values, child-process environment, and authorization data are never included.
- A remote server requiring OAuth remains unavailable until a later OAuth feature is implemented.
- The hosted server rejects malformed manifests before model invocation and never attempts MCP fallback execution.

## Security Model

Local MCP config is trusted executable configuration. Starting a local MCP server runs an arbitrary program with the user's OS permissions and inherited environment. Tool-call approval does not sandbox or make process startup safe.

Remote and local MCP metadata is untrusted. Tool names, descriptions, schemas, and results may contain prompt injection or misleading instructions. Wincode validates structure and bounds but cannot establish semantic trust. Users should enable only trusted MCP servers.

MCP credentials and connection details stay in the CLI process. The hosted service receives model-facing metadata only. The policy check occurs immediately before local execution and cannot be delegated to model instructions or the hosted server.

## Testing

### Unit tests

- JSON/JSONC discovery and duplicate-file precedence.
- Global/project field merge and invalid-section isolation.
- OpenCode v2 subset validation and timeout defaults.
- Environment interpolation, missing variables, and secret-safe errors.
- Policy parsing and `ask` default.
- Qualified naming, truncation, stable hashes, and collision rejection.
- Manifest validation, deterministic limiting, and token-cost accounting.
- MCP result normalization, binary metadata, and truncation.

### Registry and transport tests

Use injected fake clients/transports to cover concurrent connection, startup/catalog/execution timeouts, process exit, disconnect, list-changed refresh, snapshot immutability, reconnect, and deterministic shutdown.

### Hosted route and agent tests

- Accept valid dynamic manifests and reject malformed or oversized ones.
- Merge dynamic MCP definitions without weakening built-in tool validation.
- Include dynamic manifest overhead in funded input limits.
- Stream dynamic tool calls and validate subsequent dynamic results.
- Confirm no hosted dependency can execute MCP tools.

### CLI behavior tests

- Build requests include the current allowed/ask catalog snapshot.
- Plan requests omit MCP tools.
- `allow`, `ask`, and `deny` execute as specified.
- Approval cancellation and execution failures produce `output-error`.
- Calls not present in the in-flight snapshot never execute.
- Status and approval UI never render secrets.

### Integration tests

Run fixture MCP servers over stdio and Streamable HTTP. Verify discovery, model-visible dynamic schema registration, streamed call dispatch, local execution, tool-result continuation, isolated server failure, and cleanup.

## Verification

1. Focused MCP config, registry, transport, server-route, conversation, and UI tests pass.
2. `bun test apps/cli/src apps/server/src packages/ai/src` passes.
3. `bun run --cwd apps/cli check-types` passes.
4. `bun run --cwd apps/server check-types` passes.
5. `bun run --filter @wincode/ai check-types` passes.
6. `bun run check` passes.

## References

- OpenCode v2 MCP configuration: <https://opencode.ai/v2/docs/mcp-servers>
- MCP TypeScript SDK client documentation: <https://ts.sdk.modelcontextprotocol.io/v2/clients/connect.html>
