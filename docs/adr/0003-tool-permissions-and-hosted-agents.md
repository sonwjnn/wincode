# Tool Permissions and Hosted Agents

Wincode adopts the stable OpenCode v1.18.15 permission model for Agent tool calls:
top-level and per-Agent `permission` policies produce ordered `allow`, `ask`, or
`deny` decisions by matching tool-action and resource globs. Wincode owns the runtime
implementation and adapts the model to its layered configuration, current tool
catalog, MCP safety policy, and hosted billing boundary.

Status: accepted

## Considered Options

- **A complete permission system over a tool allowlist** - v1 includes global and
  per-Agent policy, granular resources, approval requests, temporary grants, and auto
  approval. The deprecated `tools: { name: boolean }` compatibility alias is not
  carried into Wincode because no shipped Wincode Agent config depends on it.
- **Stable OpenCode v1.18.15 over the development Permission V2 contract** - the
  stable user-facing schema accepts a shorthand action or an object whose keys and
  resource patterns use `*` and `?`; the last matching rule wins. Unknown action globs
  remain valid for MCP and future tools.
- **Source-first precedence over globally agent-last precedence** - defaults are
  followed by each Wincode config source from low to high precedence; within one
  source, top-level policy precedes that Agent's policy. A project-wide rule therefore
  overrides a global Agent rule, while a project Agent rule overrides the project-wide
  rule. Object/scalar transitions still replace lower subtrees according to the shared
  ConfigStore contract.
- **One generic approval service over separate coding and MCP flows** - coding tools
  and MCP tools share one request queue, dialog, temporary-grant store, reject behavior,
  and auto-approval state. Existing MCP server policy remains a separate hard ceiling;
  composing policies chooses deny over ask and ask over allow.
- **CLI-authoritative enforcement over a hosted approval round trip** - file and MCP
  side effects execute in the CLI, so the CLI evaluates actual arguments and owns
  approvals. Local and hosted model runtimes expose only tools not unconditionally
  denied. Hosted requests carry compiled tool visibility, not raw permission rules or
  local path patterns.
- **Uniform hosted descriptors over server-side Agent resolution** - every hosted
  request sends resolved Agent-specific instructions and visible tool manifests plus a
  low-cardinality billing kind (`build`, `plan`, or `custom`). Shared runtime code
  prepends immutable Wincode base instructions. The server has no copy of the client
  Agent registry.

## Consequences

- OpenCode-compatible `permission` is accepted at the Wincode top level and inside
  Agent definitions. Built-in defaults allow current tools, ask before reading
  `.env`-style files, and preserve Plan's shipped restrictions until a valid higher
  policy explicitly overrides them.
- Wincode gates coding tools, discovered MCP tools, Skill Activation, and access outside
  the workspace. Permission action `edit` covers both write and edit tools. Skill
  Activation uses the Skill name as its resource; external-directory access uses the
  canonical absolute path. User-initiated file mentions, config loading, and Custom
  Commands remain outside Tool Permission. See ADR-0004 for the Skill-specific boundary.
- Filesystem resources are canonical workspace-relative POSIX paths. Grep uses its
  regex as the resource; MCP tools use `*`. MCP permission actions use OpenCode-style
  logical `<sanitizedServer>_<sanitizedTool>` names while collision-safe hashed names
  remain an internal dispatch detail.
- Unmatched action globs remain active and emit non-fatal diagnostics. They may match a
  future or temporarily unavailable tool. Invalid global policy applies a manual-only
  all-ask safety ceiling while preserving denies; invalid built-in Agent patches use
  the same ceiling. Auto mode and remembered grants cannot bypass these safety asks or
  an explicit deny.
- Approval outcomes are allow once, always, or reject with optional feedback. Reject
  settles all pending requests in that conversation. Always grants the exact evaluated
  action/resource, is shared across Agents and conversations in the workspace, lasts
  only for the CLI process, and is inspectable and revocable through `/permissions`.
- Auto approval is off by default, can be initialized with `--auto`, and can be changed
  through `/permissions`; explicit deny remains enforced. The status bar displays an
  `auto` indicator while enabled.
- Skill access defaults to `allow`; external-directory access defaults to `ask`.
  External access composes with, rather than replaces, the permission for the underlying
  read, list, grep, write, edit, or shell operation. Targets are canonicalized and
  symlinks resolved before evaluation. Process-scoped `always` grants use exact Skill
  names or canonical parent-directory globs.
- Hosted request validation bounds Agent instructions and tool manifests. Full composed
  instructions and manifests consume the funded input budget; an oversized request is
  rejected without truncation or fallback. Billing persists only `build`, `plan`, or
  `custom`, never a user-defined Agent name.
- The hosted chat endpoint changes as a breaking contract rather than accepting legacy
  `mode` payloads. Raw permission rules and temporary approvals never leave the CLI.
