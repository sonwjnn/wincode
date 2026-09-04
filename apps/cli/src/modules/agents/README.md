# Agents

Agents are named, trusted behavior descriptors. Configure them in `wincode.json` or
`wincode.jsonc`:

```jsonc
{
  "default_agent": "build",
  "resource_limits": "extended",
  "agents": {
    "review": {
      "role": "primary",
      "description": "Review changes without editing files.",
      "instructions": "Inspect the diff and report risks.",
      "permission": { "edit": "deny" },
      "resource_limits": "deep"
    }
  }
}
```

Defaults are followed by configuration sources from low to high precedence. Object
fields merge recursively and higher sources win. Persisted conversation selection
takes precedence when reopening a conversation; an unavailable selection falls back
to Build while retaining its historical name.

`resource_limits` accepts `standard`, `extended`, or `deep`. The global value applies
to every Agent unless an Agent-specific value overrides it. Standard preserves the
normal bounded tool budgets; the elevated profiles allow larger bounded reads,
searches, listings, shell commands, and edit previews. The first elevated tool call
opens a normal approval request, and `Always allow` remembers that profile for the
CLI process. Workspace boundaries and explicit permission denies remain unchanged.

Agent instructions are trusted system input and can influence tool use. Permission
rules and the MCP safety ceiling remain authoritative and are enforced by the CLI.
Configuration changes require a restart. JSON Schema, live reload, sampling,
provider options, hidden agents, and Markdown agents are deferred. Delegated
Subagent turns use the correlated Agent Turn path.
