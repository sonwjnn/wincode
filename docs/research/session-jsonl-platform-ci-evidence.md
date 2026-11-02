# Session JSONL native-platform CI evidence

## Findings

### Codex's relevant CI pattern

Codex separates target builds from native tests. Its full Rust workflow has per-platform test jobs that call a reusable Nextest workflow: a platform archive is built, then tests run in four shards on the selected platform runner. The full path includes native Linux x64/ARM64 and Windows x64/ARM64 tests, and macOS ARM64 tests; Windows ARM64 tests run natively even when their archive is built on Windows x64. Some jobs use Codex-managed runner groups, so the useful precedent is native test execution and per-platform reporting, not copying its runner labels ([full workflow](https://github.com/openai/codex/blob/main/.github/workflows/rust-ci-full.yml), [reusable platform workflow](https://github.com/openai/codex/blob/main/.github/workflows/rust-ci-full-nextest-platform.yml)). The full path is called by Codex's post-merge workflow; the Bazel PR path uses a different, faster mix and reserves native Windows tests for post-merge runs ([post-merge workflow](https://github.com/openai/codex/blob/main/.github/workflows/postmerge-ci.yml), [Bazel workflow](https://github.com/openai/codex/blob/main/.github/workflows/bazel.yml)).

The useful pattern here is native execution on each OS, not Codex's Rust-specific archive/shard machinery. GitHub's matrix strategy creates a job for each declared configuration, and `fail-fast: false` lets the other platform jobs finish after one fails ([matrix docs](https://docs.github.com/en/actions/using-jobs/using-a-matrix-for-your-jobs)).

### What this repository's matrix establishes

The worktree's `.github/workflows/ci.yml` now has a `session-storage-platform` matrix for Linux x64, Linux ARM64, and Windows x64. Each leg verifies `process.platform`/`process.arch` and `Bun.version === "1.4.4"`, then runs the cross-process lock tests and JSONL codec/SDK tests. The SDK suite includes a contract test that waits for `FileHandle.sync()`, terminates the worker before acknowledgement, then reopens the Session and verifies duplicate replay without a second provider request. The workflow gate checks that the matrix job succeeds.

This is actual native-runtime test coverage for those three targets when the workflow completes; a successful build on another OS would not substitute. It does not exercise the Darwin lock adapters, measure performance, or simulate host/power loss. The gate is required by this workflow, but branch-protection/ruleset settings are outside the repository, so this file alone cannot establish that GitHub blocks merges when the gate fails.

### How to obtain the missing run results

The current workflow triggers for PRs targeting `master`, pushes to `master`, the weekly schedule, `workflow_dispatch`, and `workflow_call`. A feature-branch push alone does not match its `push` filter. After the changes are committed and pushed, open a PR to `master` or manually dispatch the CI workflow on that branch. GitHub documents that manual dispatch requires the workflow file to exist on the default branch, allows branch selection, and requires repository write access ([manual workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)). Record the commit SHA and all three matrix outcomes plus the required gate; until then, the Linux/Windows results are pending.

### OS and durability limits

- Linux `flock()` is advisory; locks are associated with an open file description and are released when its file descriptors are closed. Linux's documentation also describes NFS/SMB behavior that can differ from local filesystems, so a GitHub-hosted runner does not prove behavior on every network filesystem ([Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html)).
- Windows `LockFileEx` provides exclusive byte-range locks. Windows documents that locks are released when the owning process terminates, but the time to release can depend on system resources ([Microsoft `LockFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)). The cross-process contention and process-exit tests are therefore the relevant native checks.
- Bun documents `FileHandle.sync()` as a request to flush file data to storage; its implementation is OS/device-specific ([Bun API reference](https://bun.com/reference/node/fs/promises/FileHandle/sync)). The crash test covers a synced record followed by process termination, not power loss, controller caches, or all storage devices.
- The crash test calls `Bun.spawn`'s child `.kill("SIGKILL")`. Bun's tagged v1.4.4 test suite also exercises `Subprocess.kill("SIGKILL")` without excluding Windows, which supports API availability but does not replace running this repository's test on Windows ([Bun v1.4.4 test](https://github.com/oven-sh/bun/blob/bun-v1.4.4/test/js/bun/spawn/spawn-kill-signal.test.ts)).
- The lock tests create symlinks and hard links. Microsoft says unprivileged symlink creation requires Developer Mode; GitHub's hosted-runner reference says Windows VMs run as administrators with UAC disabled. This makes the hosted runner plausible for the symlink test, but the actual Windows leg remains the evidence ([Microsoft `CreateSymbolicLinkW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw), [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)).

### Benchmark follow-up

The CI matrix is correctness coverage, not a benchmark. The existing harness is `bun run --cwd packages/coding-agent bench:session-jsonl`; its 10,000-Session/100,000-checkpoint report was measured on macOS with Bun 1.3.14. Rerun the benchmark on Bun 1.4.4 and record the actual runner, architecture, runtime, workload, and report separately. The benchmark report itself notes that the existing measurements are not pinned-runtime evidence (`docs/research/session-jsonl-247-benchmark.md`).

## Current evidence status

The new workflow is in the local worktree but has not run on GitHub. The focused local suite passed 135 tests on macOS with Bun 1.3.14; that is neither Bun 1.4.4 nor Linux/Windows evidence. Keep #247 and #232 open until the native jobs and the pinned-runtime benchmark are recorded.
