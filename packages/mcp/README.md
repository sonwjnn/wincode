# `@wincode/mcp`

Application-agnostic MCP domain runtime for connecting to configured MCP servers and exposing their tools as immutable catalog snapshots.

## Owns

- MCP configuration schema, validation, and server configuration resolution.
- MCP client adapters and server lifecycle, discovery, reconnection, and status.
- Stable logical tool identities, collision-resistant dispatch identities, and manifest limits.
- Server policy evaluation, injected Agent-policy composition, and safety ceilings.
- Tool execution, result normalization, and output sanitization.

## Application boundary

This package does not depend on `coding-agent`. It does not own Wincode's `ConfigStore`, Agent policy model, Tool Gate, Session Host capabilities, or UI.

Applications inject their configuration source through `McpRegistryDeps.loadConfig` and their Agent policy through `McpAgentDecisionResolver`. The resolver is called for each logical tool while building a snapshot; the package combines that decision with the configured server decision and safety policy. Applications remain responsible for applying their own execution gate before invoking `McpRegistry.execute`.

```ts
const registry = createMcpRegistry({
  loadConfig,
  workspace,
  createClient,
});
const snapshot = await registry.createSnapshot(agentId, resolveAgentDecision);
```

The coding-agent adapter in `packages/coding-agent/plugins/mcp/` supplies Wincode configuration and policy, applies Tool Gate, and owns the process-lifetime resource. Its Session Host capability and React status UI remain in coding-agent.
