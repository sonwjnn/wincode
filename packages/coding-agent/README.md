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
