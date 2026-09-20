# Version reads and make edits recoverable transactions

A Read Tool result becomes a durable, versioned File Observation rather than transient numbered text, and Edit Tool operations consume those observations through explicit modes with bounded verification. Multi-file edits use validation atomicity, persistent path leases, staged writes, runtime rollback, and durable recovery because the filesystem cannot provide a portable atomic transaction across files. This replaces the ambiguous edit schema with one coherent safety model while preserving separate package ownership established by ADR-0010.

Status: accepted

## Decision

- Every successful valid UTF-8 text read derives a File Version from the exact file bytes, records only completely rendered Seen Lines, and retains a bounded File Snapshot. Read continuations remain bound to the observed File Version so one File Observation never mixes states.
- The File Version is a content identity: the first 16 bytes of SHA-256, rendered as 32 lowercase hexadecimal characters. It is neither a read identifier nor a revision counter.
- Editing has five explicit Edit Modes. `hashline` is the default verified single-hunk mode; `patch` is verified multi-hunk editing for one file; `apply_patch` is verified multi-file editing; `replace` performs unique exact live-text replacement; and separately permissioned `sloppy` applies bounded one-file context patches. A verified failure never downgrades automatically to `sloppy`.
- Verified modes address Line Ranges and insertion boundaries relative to a File Version. Every Edit Hunk resolves against the original File Snapshot before mutation, requires Seen Lines, rejects overlap and no-op operations, and may recover from drift only when a bounded mapping proves all intervening changes are outside the target and its boundaries.
- Whole-file replacement belongs to the Write Tool, not the Edit Tool. Creating a file is allowed; overwriting an existing file requires its expected File Version.
- Multi-file edits prepare and permission the complete canonical write set before mutation, acquire persistent per-path leases in stable order, preflight every target under those leases, stage output and original bytes, and recheck live File Versions immediately before atomic same-directory replacements.
- Runtime write failure triggers bounded rollback. Before the first replacement, the application persists a transaction manifest and required original content. An interrupted commit or incomplete rollback becomes an Unresolved Recovery with a pinned Recovery Artifact; affected paths remain blocked from coding-tool mutation until explicit reconciliation or destructive discard.
- Small diffs remain inline. A larger auditable diff becomes a session-scoped Full Diff Artifact readable through the Read Tool. File Snapshots, Full Diff Artifacts, and Recovery Artifacts have separate ownership, retention, and resource budgets.
- `@wincode/coding-tools` owns the line model, protocols, planning, resource enforcement, diffing, and filesystem mutation algorithms. The TUI composition owns Edit Mode selection, Tool Permission, persistent observations and artifacts, leases, transaction state, recovery orchestration, and presentation. Filesystem I/O stays outside SQLite transactions.
- The new protocol is a clean cutover. Legacy full-content Edit input, per-line short hashes, old replacement field names, duplicate schema sources, and compatibility execution branches are removed after callers migrate.

## Considered options

- **Keep per-line short hashes and add only a range abbreviation** — rejected because short endpoint hashes do not protect the range interior, long ranges remain awkward to authorize, and observations still cannot survive restart or line drift.
- **Use content matching without File Snapshots** — rejected because it cannot establish which version supplied line coordinates or distinguish safe unrelated drift from a conflicting change.
- **Keep one inferred union for overwrite, replacement, verified patching, and fuzzy patching** — rejected because similar fields carry different safety contracts and model-facing documentation cannot make the ambiguity reliable.
- **Use only a whole-file version and reject every drift** — rejected because unrelated edits before or after a target should be recoverable when a conservative mapping can prove the target unchanged.
- **Automatically retry verified failures with weaker matching** — rejected because that would bypass the staleness guard that reported the conflict.
- **Serialize every mutation behind one workspace lock** — rejected because independent files can proceed safely under ordered per-path leases.
- **Promise crash-atomic multi-file writes** — rejected because portable filesystems do not provide that transaction. The supported guarantee is validation atomicity, runtime rollback, crash detectability, and durable reconciliation.

## Consequences

- Read, Edit, Write, Tool Permission, session settings, persistence, artifacts, runtime failures, and recovery become one coordinated protocol change rather than independent runner edits.
- Session storage gains content-addressed snapshots, File Observations, artifact references, leases, transaction manifests, and unresolved-recovery state. The local SQLite schema continues to synchronize directly without migration history.
- Edit Mode changes take effect only when the next immutable Agent Turn tool snapshot is built.
- Read output, full-file snapshots, per-line display, unseen-line reveal, inline edit details, patch input, preflight work, recovery mapping, and Full Diff Artifacts retain separate named limits.
- Invalid UTF-8 and binary files are not Line Range editable. Large unsnapshotted files can be edited only while their live File Version still matches the observation.
- Formatting and LSP diagnostics remain outside the coding-tools mutation contract; neither can silently change mutation bytes or rollback a successful filesystem operation.
- The behavioral proof is the gated coding-tool integration seam with a real temporary workspace, real SQLite-backed persistence, the real Tool Gate, and deterministic approvals. Narrower tests are reserved for the lossless line tokenizer, path codec, recovery mapper, and fuzzy candidate scorer.

See [issue #114](https://github.com/sonwjnn/wincode/issues/114) for the complete product contract and acceptance stories.
