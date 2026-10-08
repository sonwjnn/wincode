# Coding-Agent owns the CLI distribution

Status: accepted

`@wincode/coding-agent` owns the `wincode` executable and declares `@wincode/mcp` and `@wincode/subagents` as runtime dependencies. Its application entry points select those Plugins by default, as Pi's CLI selects built-in extensions; public Session SDK callers still select Plugin paths explicitly. This removes the redundant `@wincode/cli` wrapper and ensures the module that resolves default Plugin packages declares them as dependencies. The Plugins depend on the public Coding-Agent contract as peers, while Coding-Agent does not import their implementations. This supersedes only ADR-0041's separate CLI distribution package decision and restores ADR-0027's executable boundary.
