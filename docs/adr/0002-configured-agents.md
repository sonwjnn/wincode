# Configured Agents

Wincode models an Agent as a named AI behavior with an Agent Role of `primary`,
`subagent`, or `all`. Built-in Build and Plan are Primary Agents; user-owned
Configured Agents are declared inline under an `agents` record in `wincode.json`
or `wincode.jsonc`. The canonical selection is an Agent, not a Coding Mode.

Status: accepted

## Considered Options

- **Inline named records over Markdown paths** - v1 is specifically a JSON/JSONC
  capability. `agents: { <name>: { ... } }` supports field-level project overrides
  through the shared ConfigStore without adding another discovery format. Markdown
  agents and `agents.paths` are deferred until there is a demonstrated sharing need.
- **Wincode vocabulary over OpenCode field compatibility** - the top-level key is
  plural `agents`; eligibility is `role`, not the overloaded `mode`; agent-specific
  system text is `instructions`, not the ambiguous `prompt`. The deprecated OpenCode
  `tools` alias is not accepted.
- **One Agent selector over separate Agent and Mode selectors** - `/agents` and agent
  cycling contain only effective `primary` and `all` Agents. Definitions with role
  `subagent` are loaded now so the config contract does not need to change when
  delegation is added, but v1 does not execute or manually invoke them.
- **Patchable built-ins over shadowing or replacement** - `agents.build` and
  `agents.plan` may patch description, instructions, model, variant, and permission.
  Their reserved identities and `primary` roles are immutable, and they cannot be
  disabled. Configured instructions replace the built-in-specific text while the
  Wincode base instructions remain immutable.
- **Catalog-backed model overrides** - optional `model` uses
  `<connectionProviderId>/<modelId>` and is authoritative for that Agent. Optional
  `variant` is valid only with a configured model and must belong to that model's
  catalog entry. Without a model, the Agent inherits the conversation model and
  variant.

## Consequences

- A Configured Agent name is lowercase kebab-case, 1-64 characters. Effective custom
  definitions require `role` and a non-empty `description`; `instructions`, `model`,
  `variant`, and `permission` are optional. `disable: true` is a layerable tombstone
  for Configured Agents only.
- Agent patches are strict: unknown Agent fields are errors rather than provider
  option passthrough. Instructions are literal strings capped at 12,000 characters;
  file and environment interpolation are not supported.
- The effective registry is bounded to 64 Configured Agents. Descriptions and
  permission patterns are capped at 512 characters, and each Agent is capped at 256
  flattened Permission Rules.
- ConfigStore object fields merge recursively and higher sources win. Invalid
  effective Configured Agents are omitted rather than falling back to a lower,
  potentially more permissive definition. Invalid built-in patches revert to the
  shipped definition under a manual-approval safety ceiling.
- `default_agent` selects the initial Agent for new conversations. It must resolve to
  an available `primary` or `all` Agent; otherwise Wincode visibly falls back to Build.
  Persisted conversation selection takes precedence when reopening a conversation.
- `/agents` orders the effective default first and all other selectable Agents by
  canonical ID. Model-pinned Agents with a missing Connection remain visible but are
  disabled; an unavailable configured default falls back to Build with a notice.
- Persisted conversation state and message metadata migrate from `mode` to `agent`.
  Legacy `mode: build | plan` metadata is normalized when read; new writes use only
  `agent`. If a saved Agent no longer resolves, history retains its name while the
  active selection visibly falls back to Build.
- Config changes require a restart. A first-resolution toast summarizes diagnostics,
  and `/agents` retains source-attributed details. Editor-facing JSON Schema, live
  reload, sampling controls, provider options, color, hidden agents, Markdown agents,
  and Subagent execution are deferred.
