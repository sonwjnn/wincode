# Shell Tool with Permission-Gated Execution

Wincode adds a native `shell` coding tool that executes Agent-authored commands on the
user's machine, always through Tool Permission and the approval flow. The tool is
CLI-only: side effects and approvals execute in the CLI, never through the hosted
runtime. Every execution is bounded (timeout, output cap, no stdin, process-tree kill),
and a command safety classifier keeps destructive commands behind an approval even when
shell access has already been granted.

Status: superseded by ADR-0008 (shell-permissive-posture)

## Considered Options

- **A single `shell` tool over dedicated task tools** - one tool takes `command`,
  optional `cwd`, and optional `timeout`. The runner selects the shell per platform:
  `/bin/bash -c` on POSIX and `powershell.exe -Command` on Windows, with platform
  detection injected as a pure builder. The tool description is composed per platform so
  the Agent knows which syntax to write before the first call. Dedicated runners for
  specific tools (`bun`, `git`) are deferred until a tool-specific contract earns them.
- **Deny-by-default `ask` posture over default `allow`** - the new `shell` action
  defaults to `ask`: the Agent cannot execute anything until the user approves or
  grants. An always approval persists a process-scoped `shell *` grant so routine loops
  are not interrupted; auto approval (`--auto`) and grants never bypass an explicit deny
  or a safety ask.
- **An automatic command safety ceiling over grant-only control** - a pure classifier
  normalizes the command (case, whitespace, quoting) and matches seven destructive
  pattern groups: root-level `rm -rf`, `sudo`, `curl|sh` and `wget|sh` pipelines, `dd`
  to block devices, `mkfs`/`fdisk`/`diskutil`, `shutdown`/`reboot`, and fork bombs.
  Matches mark the approval `safety: true`, which rejects the always/remember option and
  survives `--auto`, mirroring the existing manual safety ceiling.
- **cwd through the existing sandbox over free placement** - the default working
  directory is the resolved workspace root. Workspace-internal `cwd` values run
  directly; paths outside the workspace compose with the existing `external_directory`
  ask, canonicalized and symlink-resolved like file tools.
- **Bounded execution over open-ended runs** - 30 s default timeout (per-call override,
  300 s cap), no stdin, no TTY, and process-tree termination when the command finishes
  or times out so orphaned background processes do not survive the tool call. Output
  keeps the tail at 30 KiB with a truncation banner. Interactive commands fail fast
  instead of hanging the Agent loop.
- **Bounded preview with on-demand expansion over expanded-by-default output** -
  shell is the first coding tool whose output renders in the conversation: one
  themed block groups the command header (bounded to two visual rows, ending in
  an ellipsis when longer), the execution status (exit code, timeout,
  truncation, with failures using the theme's error treatment), and a preview
  of the beginning of the sanitized result (bounded to six visual rows measured
  against the block's content width with terminal-cell semantics). Output that
  fits the preview stays fully visible without an expansion affordance;
  overflowing blocks report the hidden content (`… N more lines`, or
  `… more output` when only wrapping hides it) and expand inline on click.
  Expansion is transient UI state, and settled tool parts keep an immutable
  rendering boundary so streamed updates of neighboring messages never
  re-sanitize or re-lay-out large results. Other tools keep their summary-only
  rendering.
- **Workspace-root walk-up over the fixed process working directory** - the CLI resolves
  its workspace root by walking up to the nearest `.git` (bounded), replacing the fixed
  `process.cwd()` root. Launching the CLI from a subdirectory no longer places the
  repository outside the sandbox, which is what kept shell-dependent Skills such as
  `git-commit` from executing.
- **CLI-only over hosted availability** - the hosted runtime does not advertise `shell`
  in its tool manifests: hosted requests have no local approval path (ADR-0003), and
  shell side effects must stay CLI-authoritative. Hosted descriptors validate `shell`
  as a known name but reject it for hosted execution.

## Consequences

- `shell` joins the coding tool catalog with `command` required (max 4,096 characters),
  `cwd` optional, and `timeout` optional (1-300 s). The Plan Agent's shipped rules deny
  `shell`, preserving its read-only contract, which a granted shell would otherwise
  bypass.
- The `shell` permission action joins the action vocabulary with default `ask`; the
  static tool-to-action mapping and the always-grant lookup extend to it. Always grants
  for shell persist `shell *`; grant lookup gains wildcard support where exact-match
  lookup cannot satisfy it.
- Safety-classified commands always surface the safety ceiling: they cannot be
  remembered, auto-approved, or policy-allowed into unconditional execution. `--auto`
  and remembered grants skip ordinary `ask` decisions but never safety asks.
- Windows execution decodes UTF-16 output, terminates process trees with
  `taskkill /T /F`, and composes `cwd` resolution with Windows path semantics.
- The server integration fixture that rejected `shell` as an unknown tool name is
  updated: `shell` is now a known name but not executable on the hosted runtime.
- The truncation banner and timeout error are model-visible, so the Agent can adapt
  (retry with a longer timeout, or read the tail of a file instead).
- Shell-dependent Skills (e.g. `git-commit`) start working without Skill-side changes
  once the tool and the workspace-root walk-up land. ADR-0003 already anticipated a
  `shell` operation action; this ADR records its design.
