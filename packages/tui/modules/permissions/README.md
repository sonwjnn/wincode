# Tool Permissions

Permissions use the supported JSON/JSONC contract at the top level or inside an
Agent. Rules are shorthand actions or resource maps with `allow`, `ask`, or `deny`:

```jsonc
{
  "permission": {
    "read": "ask",
    "edit": { "*.env*": "deny", "src/**": "allow" }
  },
  "agents": {
    "review": {
      "role": "primary",
      "description": "Review files",
      "permission": { "edit": "deny" }
    }
  }
}
```

Defaults are followed by configuration sources from low to high precedence. Within
one source, top-level permission rules precede the Agent's rules; the last matching
rule wins. Explicit denies and the MCP safety ceiling cannot be bypassed by approval,
auto mode, or remembered grants.

Shell resources match as string globs against each parsed command node (`*`
crosses `/`, so `rm *` catches `rm src/index.ts`): harmless commands run
without approval while the shipped `rm *` and `sudo *` denies block destructive
commands, and those denies are ordinary overridable rules (ADR-0008).

The CLI evaluates actual tool arguments and owns approvals. Raw permission rules,
paths, and temporary grants never cross the hosted boundary. Configuration changes
require a restart. Permission V2, editor-facing schema, live reload, and provider
options are deferred; approvals, temporary grants, auto approval, and `/permissions`
inspection are supported.
