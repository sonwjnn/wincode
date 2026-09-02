# Permissive shell posture

Wincode's shell tool defaults to `allow` for commands that pass parsing and the safety ceiling. Shipped rules still require approval for destructive command patterns such as `rm *` and `sudo *`; explicit user policy may tighten or relax those rules where permitted.

Status: accepted

## Decision

- Parse shell command nodes with the platform tree-sitter grammar when available.
- Fail closed for malformed or unsupported syntax.
- Resolve `cd`-family nodes using the workspace-aware path rules.
- Bound command time, output, and process lifetime.
- Keep the manual-approval safety ceiling for malformed configuration and agents that require manual approval.

## Consequences

The CLI evaluates each command and owns its approval state. Tool output remains local and is returned directly to the local agent loop.
