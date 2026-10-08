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
