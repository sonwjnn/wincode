# Shell tool with permission-gated execution

Wincode provides a native `shell` coding tool for commands executed on the user's machine. Every command crosses the Tool Permission service and the approval flow before side effects occur.

Status: accepted

## Decision

- Shell execution is bounded by timeout, output limits, no stdin, and process-tree termination.
- Commands are parsed with the platform shell grammar when available; malformed commands fail closed.
- A safety classifier keeps destructive commands behind approval even when a temporary grant exists.
- The tool receives the workspace root as its default working directory and applies platform-specific path semantics.
- Tool output and timeout errors are returned to the local agent loop so the agent can adapt.

## Consequences

Shell is a local capability. Permissions evaluate the actual command and resolved arguments in the CLI. No shell command, approval state, or filesystem path leaves the local process.
