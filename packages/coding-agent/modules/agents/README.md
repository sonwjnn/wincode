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
      "tools": ["read", "grep", "glob"],
      "resource_limits": "deep"
    }
  }
}
```

Defaults are followed by configuration sources from low to high precedence. Object
fields merge recursively and higher sources win. Persisted session selection
takes precedence when reopening a session; an unavailable selection falls back
to Build while retaining its historical name.

`tools` selects which native coding tools are exposed to an Agent; omitted values
use that Agent's defaults. `capability_ceiling.tools` can further restrict tools in a
new delegated Session. These are model-visible tool selections, not per-call
approval policies.

`resource_limits` accepts `standard`, `extended`, or `deep`. The global value applies
to every Agent unless an Agent-specific value overrides it. Standard preserves the
normal bounded tool budgets; the elevated profiles allow larger bounded reads,
searches, listings, shell commands, and edit previews. Resource limits remain active
without asking for per-call approval. Tools run with Wincode's process privileges;
use operating-system isolation when stronger containment is required.

Agent instructions are trusted system input and can influence tool use. Configuration
changes require a restart. JSON Schema, live reload, sampling, provider options,
hidden agents, and Markdown agents are deferred. Delegated Subagent turns use the
correlated Agent Turn path.
