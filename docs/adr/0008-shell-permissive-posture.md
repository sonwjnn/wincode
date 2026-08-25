# Shell Permission: Permissive Posture

Wincode's `shell` tool flips to a permissive posture: shell commands default to
`allow`, shipped default denies cover `rm *` and `sudo *` as overridable rules,
commands are matched as string globs and evaluated per command node via a
tree-sitter parse (fail-closed), cd-family nodes are exempt, "Always allow"
records the exact normalized command, and a doom_loop guard turns repeated
identical tool calls into an ordinary ask. This supersedes ADR-0005's
deny-by-default ask posture, its automatic destructive-command safety ceiling,
and its `shell *` always grant; the manual-approval safety ceiling is unchanged.

Decision source: the grilling session for the shell-permission work (issue #34),
with the approval-model prototype captured at
`apps/cli/src/modules/permissions/shell-approval-prototype.html` (branch
`prototype/shell-approval-model`, commit 5517102).

Status: accepted

## Supersedes (ADR-0005)

These ADR-0005 decisions are superseded by this record:

- **Deny-by-default `ask` posture** - superseded by permissive allow defaults.
- **Automatic command safety ceiling** - superseded by the shipped default deny
  set (`rm *`, `sudo *`), which is overridable config, not a ceiling.
- **Process-scoped `shell *` always grant** - superseded by exact-command grants.

ADR-0005's remaining decisions (CLI-only execution, bounded execution, bounded
preview with on-demand expansion, workspace-root walk-up, Windows output
decoding and process-tree termination, the server fixture that accepts `shell`
as a known but non-executable hosted name) stay in force.

**Unchanged:** the manual-approval safety ceiling. Malformed config and
`requiresManualApproval` agents still force manual approval; always-grant
recording stays skipped when the decision came from that ceiling.

## Considered Options

- **Permissive allow defaults over deny-by-default ask (accepted)** - the
  `shell` action defaults to an ordered resource map with the catch-all first:
  `{ "*": "allow", "rm *": "deny", "sudo *": "deny" }`. The catch-all must
  precede the specific rules because last-match-wins would otherwise let `"*"`
  silently override every specific rule (prototype finding). Deny-by-default
  stays rejected: every harmless command shares the `rm -rf` approval dialog,
  approval is binary instead of graded, and the posture cannot lower friction
  for routine navigation.
- **Shipped default denies over an automatic classifier ceiling (accepted)** -
  the deny set is the pi-style `rm *` / `sudo *` pair, shipped as ordinary
  overridable rules (`ask`/`allow`) so legitimate workflows need no code
  change. The ADR-0005 classifier families (`curl|sh` and `wget|sh` pipelines,
  `dd` to block devices, `mkfs`/`fdisk`/`diskutil`, `shutdown`/`reboot`, fork
  bombs) ship no default rule: they run like OpenCode, a documented risk that
  users harden with their own denies. A classifier ceiling stays rejected
  because it can only raise risk, never lower friction, and removes control
  from config.
- **String globs for shell resources over path globs (accepted)** - the shell
  action matches resources with `*` → `.*`, which matches `/`, so a deny like
  `rm *` catches `rm src/index.ts`. File-path actions keep the existing path
  glob (`*` → `[^/]*`); the policy engine selects the matcher per action.
- **Per-command-node tree-sitter evaluation over whole-command matching
  (accepted)** - the command is parsed with the bash and powershell tree-sitter
  grammars, and each command node (compound statements, pipelines, redirects)
  is its own resource evaluated against the rules. Per-node decisions compose
  most-restrictively (deny > ask > allow). A parse failure fails closed to
  ask, so a parser bug never silently allows. Whole-command string matching
  stays rejected because a compound like `cd ~ && rm -rf *` must deny on the
  `rm` node, not fall through as a single opaque string.
- **cd-family exemption (accepted)** - command nodes whose command is
  `cd`/`chdir`/`pushd`/`popd`/`push-location`/`set-location` skip the shell ask
  entirely, so the agent navigates freely; a call-level `cwd` outside the
  workspace still composes the `external_directory` ask, preserving the
  workspace boundary. A blanket cd exemption without the boundary compose
  stays rejected.
- **Exact-command grants over wildcard grants (accepted)** - "Always allow"
  records the exact normalized command as the grant key
  (`shell <normalized command>`); only an identical subsequent command
  matches. Grants stay process-scoped, shared across Agents and conversations
  in the workspace, and inspectable and revocable through `/permissions`,
  aligning shell with ADR-0003's exact (action, resource) grants. The
  ADR-0005 `shell *` grant and OpenCode-style prefix grants stay rejected:
  approving `git commit -m init` must not unlock `rm -rf src/`.
- **doom_loop as an ordinary ask (accepted)** - per-conversation repeat
  tracking in the tool gate, applying to every tool family (static coding
  tools and MCP). The third identical (family, tool, input) call turns the
  decision into an ordinary `ask`: `--auto` bypasses it, an explicit deny
  never does, and any differing call resets the counter. A hard block or a
  non-bypassable ceiling stays rejected - runaway loops stay interruptible
  while automation stays predictable, matching OpenCode.
- **Manual-approval ceiling unchanged (accepted)** - malformed config and
  `requiresManualApproval` agents keep the manual-only all-ask ceiling with
  its denies preserved; it is a separate safety source from the shell posture
  and untouched by this flip.

## Consequences

- The `shell` action defaults to allow with shipped `rm *` / `sudo *` denies;
  `pwd`, `cd`, `ls`, and read-only git commands run without approval. This is
  a breaking posture change, announced in the changelog for 0.1.0.
- An explicit deny is absolute: remembered grants and `--auto` never bypass
  it. Users override the shipped denies per command or family via config.
- Shell resources match as string globs (`*` matches `/`); file-path actions
  keep path-glob semantics; the matcher is selected per action.
- Compound commands evaluate per node, so `cd ~ && rm -rf *` denies on the
  `rm` node, and deny patterns need only match the command node, not the full
  string. Parse failure fails closed to ask.
- cd-family nodes never prompt inside the workspace; a `cwd` outside the
  workspace still composes the `external_directory` ask.
- "Always allow" records the exact normalized command; only an identical
  subsequent command matches. Grants remain process-scoped and inspectable
  and revocable via `/permissions`. Grant recording stays skipped under the
  manual safety ceiling.
- The same tool call repeated three times with identical input asks
  (doom_loop); `--auto` bypasses the ask, an explicit deny never does.
- The approval panel drops the destructive-command `safetyReason` banner; the
  manual-ceiling safety banner still renders for malformed-config and
  `requiresManualApproval` asks.
- Unchanged surfaces: `--auto` semantics; `read`/`edit`/`list`/`grep` defaults
  and `.env` asks; `external_directory` default and composition; Skill
  approval; MCP policy composition; the Plan Agent's shipped `shell: deny`.
- The `shell` tool description notes the permissive posture so agents know
  `rm`/`sudo` are blocked by default and configurable.
- Known accepted limitation: deny patterns match command nodes; shell syntax
  that avoids the denied token (e.g. `git clean -fd`, `find . -delete`) is not
  intercepted - policy is a permission layer, not a sandbox, the same caveat
  OpenCode documents.
- Default blocking for `curl|sh`, `dd` to block devices,
  `mkfs`/`fdisk`/`diskutil`, `shutdown`/`reboot`, and fork bombs is dropped;
  users can add denies for those families via config.
