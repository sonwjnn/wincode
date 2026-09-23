# Coding-Agent application owns execution modes

Status: accepted

Wincode's private application boundary is `@wincode/coding-agent`, which owns the `wincode` executable entrypoint, application composition, and four peer execution modes: Interactive, Print, JSON, and RPC. A bare invocation runs Interactive Mode; `--mode`/`-m` selects a non-interactive mode, while `--prompt`/`-p` supplies one-shot input. This supersedes ADR-0011's separate `@wincode/cli` → `@wincode/tui` application boundary without changing the reusable `@wincode/agent-core` boundary.

## Decision

- `@wincode/coding-agent` replaces the private `@wincode/cli` and `@wincode/tui` packages. Inside the package, `cli/` is the executable composition root, `tui/` is the Interactive adapter, and `modules/application/` owns mode orchestration. The package also owns CLI parsing, help/version, process exit-status mapping, OpenTUI, persistence, connections, MCP, permissions, Session Hosts, and mode adapters.
- The short flags are `-m` for `--mode` and `-p` for `--prompt`; mode values remain full names, with no `p`/`j`/`r` mode aliases.
- An Execution Mode is a Strategy supplied by the `cli/` composition root. Modes receive a shared application context and use the same Session Host and Session Engine contracts; they do not implement independent agent loops or session state owners. `modules/application/` never imports the concrete `tui/` adapter.
- `packages/coding-agent/index.ts` is the canonical application interface for package consumers and re-exports `modules/application/application.ts`. The package `.` export points both `types` and `import` at `index.ts`; there is no duplicate `./application` alias. `cli/`, `tui/`, and `modules/application/` remain implementation directories, while the explicit Session Host, capability, and RPC subpath exports expose only their UI-neutral contracts.
- Interactive Mode is the default bare `wincode` invocation. Print and JSON are one-shot modes that open or create a durable One-Shot Session, accept exactly one Submission from `--prompt`/`-p` or stdin, and end after the terminal Agent Turn outcome. JSON emits the public Agent Turn event projection as JSONL; pre-turn invocation or composition failures emit one standalone machine-readable `{"error": string}` record; Print emits only human-readable assistant text.
- RPC Mode is selected with `wincode --mode rpc` or `wincode -m rpc`. Its JSON-RPC 2.0 and strict JSONL protocol, initialization sequence, one-Session-Host-per-process rule, error codes, projections, and shutdown semantics remain those of ADR-0025. The legacy `wincode rpc` invocation is removed rather than retained as a compatibility alias.
- Print and JSON fail closed when a Tool Permission `ask` has no interactive settlement. `--auto` may satisfy ordinary asks; safety asks and explicit denies remain non-bypassable. Every mode returns an exit code, and only the executable entrypoint assigns `process.exitCode`.
- Explicit one-shot Agent, Model, and Thinking Level selectors override restored Session Selection. A new One-Shot Session is not created until its complete Invocation Selection resolves.
- The `cli/` composition root may load resources lazily. Help/version do not load the interactive runtime; Interactive Mode composes the renderer, while non-interactive modes use the React-free Session Host capability graph.

## Considered options

- **Keep separate CLI and TUI packages** — rejected. It leaves the application composition root split across a forwarding executable package and a package whose name describes only one of its four execution surfaces.
- **Make every mode a separate agent loop** — rejected. It would duplicate prompt, streaming, approval, persistence, and shutdown semantics around the same Session Engine.
- **Use `wincode rpc` and additional named subcommands for every mode** — rejected. Execution modes use one explicit `--mode` selector, while the bare invocation remains the ergonomic Interactive Mode entrypoint and future independent administrative commands retain a separate CLI namespace.
- **Create ephemeral Print/JSON sessions** — rejected. One-shot interfaces must preserve durable Session Records and the same lease and selection semantics as other session consumers.

## Consequences

- ADR-0023's Session Host ownership, opening, lease, subscription, and shutdown contract remains accepted; its temporary package-location decision (`@wincode/tui`) and deferral of a coding-agent application package are revised by this ADR.
- The RPC adapter, protocol, projection, and request handling move under the coding-agent application's RPC mode, while the wire contract remains stable.
- The clean cutover removes `@wincode/cli`, `@wincode/tui`, and `wincode rpc`; all imports, tests, package references, and documentation must migrate to the coding-agent vocabulary.
