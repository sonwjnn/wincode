# Agents

Agents are named, trusted behavior descriptors. Configure them in `wincode.json` or
`wincode.jsonc`:

```jsonc
{
  "default_agent": "build",
  "agents": {
    "review": {
      "role": "primary",
      "description": "Review changes without editing files.",
      "instructions": "Inspect the diff and report risks.",
      "permission": { "edit": "deny" }
    }
  }
}
```

Defaults are followed by configuration sources from low to high precedence. Object
fields merge recursively and higher sources win. Persisted conversation selection
takes precedence when reopening a conversation; an unavailable selection falls back
to Build while retaining its historical name.

Agent instructions are trusted system input and can influence tool use. Permission
rules and the MCP safety ceiling remain authoritative and are enforced by the CLI.
Configuration changes require a restart. JSON Schema, live reload, sampling,
provider options, hidden agents, Markdown agents, and subagent execution are deferred.
