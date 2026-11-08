# @wincode/coding-agent

Application and SDK package that owns the `wincode` executable, Interactive,
Print, JSON, and RPC execution modes, and the shared Session Host composition.
It declares MCP and Subagents as runtime dependencies for its application defaults;
public Session SDK callers select Plugin paths explicitly.

The canonical application import is `@wincode/coding-agent`, backed by the
package-root `index.ts` barrel. `bin/`, `tui/`, and `modules/application/` are
implementation paths; `@wincode/coding-agent/application` is intentionally not
exported. Session Host, capability, and RPC contracts use their explicit
UI-neutral subpath exports.

Searchable list dialogs and skill suggestions share `shared/fuzzy.ts` for
subsequence matching. Interactive lists preserve their original item order.

```bash
bun run bin/wincode.ts --help
bun run bin/wincode.ts --mode print --prompt "hello"
```

## Interactive errors and actions

Model errors appear as red `Error: …` lines in the transcript, without persistent
Retry or Rewind controls. `Alt+W` toggles transcript actions when the Session is
idle; `Alt+R` retries the latest retryable input. Rewind creates a fork and does
not roll back workspace files.

Transient model request failures retry up to three times with exponential delays
starting at two seconds. Reported usage and partial text or reasoning do not by
themselves stop a safe retry: failed-attempt usage is counted once, and bounded
attempt summaries remain inspectable on the terminal event and Session Record.
Partial output is never added to the next request's Model Context. Each retry uses
a fresh Model Step identity. A Model Step is retried only before its Tool Calls
begin execution; a later Model Step can retry without replaying previously settled
Tool Calls. Authentication, authorization, account-limit, and invalid-request
failures do not retry. The composer shows one countdown; Escape cancels a pending
retry immediately.
Retry-After can extend the delay up to 60 seconds; a longer requested delay ends
the turn rather than retrying early. Cache-warm replays remain best-effort and
do not use this retry loop.

The bounded policy can be changed in `modelRetry` settings:

```json
{
  "modelRetry": {
    "enabled": true,
    "maxRetries": 3,
    "baseDelayMs": 2000,
    "maxDelayMs": 60000
  }
}
```

`maxRetries` excludes the initial request. Invalid settings disable automatic
retries rather than falling back to a more permissive policy.

## Project trust

Before loading protected project configuration and resources—including configured
Plugins, MCP Servers, Skills, and Custom Commands—the CLI resolves Project trust.
Interactive TTY sessions show the Project Trust selector before loading protected
resources when any protected root has no applicable saved decision. It lists each protected
root and its saved decision; Escape or Ctrl+C
continues without those resources for this run and saves no decision. `/trust`
shows the same per-root status and offers the same choices: trust the project,
trust its parent folder, or keep it untrusted. Decisions are stored outside the
project in `~/.wincode/project-trust.json`. Run `/reload` afterward to apply a
changed decision; `/reload` never prompts or grants trust. Print, JSON, RPC, and
SDK entry points never prompt or silently trust. Use `--trust-project` or
`--no-trust-project` for an explicit CLI invocation decision; SDK callers use the
`projectTrust` option. `AGENTS.md` remains contextual guidance and does not
trigger trust.

Project trust authorizes Wincode to load project resources; it is not a sandbox.
Trusted Plugin code and local MCP processes run with Wincode's operating-system
privileges. Use OS-level isolation when stronger containment is required.
