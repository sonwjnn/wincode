# Separate CLI dispatch from the TUI application

Wincode separates its executable dispatch boundary from its interactive application. The private `@wincode/cli` package owns the `wincode` binary, Commander-based dispatch, help, version, diagnostics, and process exit status; the private `@wincode/tui` package becomes the composition root for the existing OpenTUI application, routing, sessions, persistence, configuration, credentials, MCP, permissions, and approvals.

Status: accepted

## Decision

Bare `wincode` invocation is the only way to launch the TUI; there is no `wincode tui` command. The CLI forwards default-invocation arguments to `@wincode/tui` without interpreting TUI options, and lazy-loads the package so help, version, and future non-TUI commands do not load the interactive application. Named CLI Commands are a statically registered, in-process set dispatched by Commander and may complete without launching the TUI. Dependency direction is one-way from `@wincode/cli` to the narrow `@wincode/tui` entry point.

Command handlers return exit codes and do not terminate the process. The executable adapter alone sets process exit status; the TUI owns renderer lifetime, terminal interaction, and cleanup. This revises only the application-boundary decision recorded in ADR-0010; its reusable agent package graph remains unchanged.
