# Session JSONL #247 acceptance evidence

This document maps every acceptance criterion in
[#247](https://github.com/sonwjnn/wincode/issues/247) to evidence produced on this
branch. It records what was actually run, on which platform, and what remains
unproven. Nothing here upgrades a test into a guarantee it does not make.

## Method

- Repository: `/Users/thyhaly/orca/workspaces/wincode/session-jsonl-integration`,
  branch `integration/session-jsonl-232`, PR #249.
- Local runtime: Bun 1.3.14, macOS Darwin 24.6.0 arm64 (Apple M1, 16 GiB).
- Native platform evidence: GitHub Actions run `41593575985` (all matrix legs and
  the Required test gate green) plus the earlier runs recorded in
  `session-jsonl-platform-ci-evidence.md`. CI pins Bun 1.4.4.
- Interactive smoke: `./scripts/test-support/interactive-smoke-launcher.sh` in
  tmux 3.5a, fake Provider plugin, isolated temporary HOME and workspace. No
  external Provider request was made.

## 1. No remaining SQLite-authoritative writer, legacy reader, or dual write

Production composition always wraps the projection store in the JSONL store:

- `modules/sessions/storage/get-session-store.ts`
- `modules/sessions/host/session-capabilities.ts`
- `modules/sessions/storage/reset-local-session-data.ts`

`createDrizzleSessionStore` is only constructed by those three call sites and by
the benchmark script. The `SessionStore` type in
`modules/sessions/storage/session-store.ts` omits the projection write members
(`commitSessionRecord`, `createSession`, `updateSession`,
`updateSessionSubmission`, `deleteSession`, `appendCompaction`,
`createSessionUsageEntry`, `setEditMode`) and redefines them to return
`SessionWriteOutcome` receipts, so a caller cannot write history through the
projection interface without going through the log.

The operational database keeps workspace bindings and local artifacts; the
transcript projection lives in `session-projection.sqlite`. Contract test:
`the Session projection stays out of the operational SQLite database`
(`test/sessions/session-jsonl-sdk.test.ts`).

Observed on disk during the smoke run:

```text
<data-root>/sessions.db                       operational
<data-root>/session-projection.sqlite         rebuildable projection
<data-root>/session-logs/<session-id>/session.jsonl
<data-root>/session-logs/.staging/
<data-root>/session-control/{locks,catalog.lock,deleted,imports,quarantine,receipts,indeterminate}
```

No legacy transcript table, dual-write path, or SQLite-authoritative reader was
found in production modules. `drizzle.config.ts` still points `db:push` at the
operational database file; both files are created and evolved by the single
`initializeSchema` in `storage/client.ts`, so the projection schema is not a
second, drifting definition.

## 2. Clean cutover without migration or backward compatibility

- The branch contains no SQLite-to-JSONL migration, no dual-write, and no
  compatibility backend; `SessionDatabaseResetRequiredError` fails closed when a
  local database uses an incompatible schema and instructs the operator to run
  `bun run --cwd packages/coding-agent db:reset-sessions`.
- `reset-local-session-data.ts` and `scripts/reset-session-data.ts` clear Session
  data through the JSONL store, keeping prompt history, workspace bindings, and
  unresolved operational recovery.
- PR #249 states the one-way door and requires old binaries to stop before this
  version writes Session data.

## 3. Schema initialization and lifecycle metadata consistency

- One `initializeSchema` and one Drizzle schema define both database files.
- Lifecycle metadata is durable filesystem state under `session-control`, not a
  second query index; deletion markers and import activation markers survive a
  projection rebuild.
- Tests: `projection rebuild replays published history without clearing
  operational data`, `import activation remains pending across projection
  rebuild and is logged before release`, `a durable deletion marker reports
  cleanup pending and the same operation retries to completion`.

## 4. Cross-feature tests

| Required combination | Evidence |
| --- | --- |
| import/fork, then delete source | `a forked imported Session keeps attachments live after deleting and collecting its source`; `forked attachment references remain live after source deletion and attachment collection` |
| rebuild, then continue steering/SDK delivery | `SDK delivery retries preserve one durable receipt across projection rebuild and restart`; `processing steering status reopens as a failed durable head with stable identities`; **new** `a rebuilt failed Steering Message retries to one provider request without a duplicate user record` |
| GC during portability | `GC cannot reclaim closure blobs while export copies pinned source attachments`; `attachment collection during import staging and publication preserves imported blobs`; `Session deletion cannot race GC while its published log is being removed` |
| fixed pagination after status changes | `Session history pages keep status and log position at their captured prefix`; `Session catalog pages keep ordering and metadata at their captured revision`; `Session catalog cursors expire after a Session is deleted` |
| deletion and crash | `recovery completes a synced deletion event before catalog discovery can return the Session`; `deletion keeps its durable marker and reports cleanup pending when log removal fails`; `Session deletion persists a tombstone receipt before removing the projection` |

The new steering test closes the one combination that was previously only
half-covered: a projection rebuild replayed a `processing` Steering Message into
a failed durable head, but nothing proved the head could then be continued.
The test rebuilds the projection, retries the failed head through
`AgentSession.send({ messageId })`, and asserts one provider chat request, an
emptied steering queue, and exactly one durable user record for that message.

## 5. Supported-platform sync/OS-lock evidence and fault matrix

- Native matrix in `.github/workflows/ci.yml`: Linux x64, Linux ARM64, Windows
  x64, pinned to Bun 1.4.4. Run `41593575985` passed all three legs plus the
  Required test gate. Run `41794661925` (attempt 2) also passed all three legs
  and the gate for this branch head; attempt 1 failed two Windows statistics
  tests with a transient `session_log_write_not_committed` error while writing a
  pending write marker, and the failed-job rerun passed without a code change.
  That failure is recorded here as observed flakiness, not as a passing result.
- Fault matrix rows from spec §12 are defended by the Session storage suites:
  short write and ENOSPC (`short writes are retried so Session creation and
  append remain complete`, `ENOSPC and quarantine sync failure preserve the log
  for reopened same-operation retry`), indeterminate writes
  (`an indeterminate steering write keeps its queue entry reserved until
  reconciliation`), blocked projection (`committed steering leaves its queue
  reservation settled when the projection blocks`, `a durable log commit reports
  its receipt when SQLite projection fails`), tail repair and corruption
  (`a valid JSONL prefix below the projection cursor blocks Session reopen with
  its byte boundary`), competing projectors (`two concurrent replay readers
  reload when one advances the projection cursor`), and rebuild
  (`projection rebuild failure rolls back replacement rows and cursor`).
- Limits: hosted-runner coverage is Linux x64/ARM64 and Windows x64 only. Tests
  terminate processes; they do not simulate power loss, controller caches, or
  arbitrary filesystems. No universal durability guarantee is claimed.

## 6. Benchmark fixtures

`docs/research/session-jsonl-247-benchmark.md` and
`session-jsonl-247-bun-1.4.4-combined-benchmark.json` record 10,000 Sessions and
one Session with 100,000 checkpoints, page limits 50 and 200, status revisions,
and same-timestamp ordering, measured with a SHA-256-verified Bun 1.4.4 binary on
macOS arm64. Cold discovery, rebuild, and catch-up are reported separately from
warm pagination and statistics, with latency, memory, and environment metadata.

## 7. Warm queries avoid parse-all and use scope indexes

- `a fresh history page stats an unchanged log instead of decoding full history`
- `a fresh catalog page stats unchanged logs instead of decoding full histories`
- `Session page and statistics queries use scope indexes without temporary sorts`
- Catch-up advances only over the unprojected suffix: `a fresh Session catalog
  page catches up committed metadata when projection is blocked`,
  `a Session read refreshes its log snapshot when a writer advances the cursor`.

## 8. Formatting, type checks, portfolios, and interactive smoke

Local verification on the branch head:

| Command | Result |
| --- | --- |
| `bun fix` / `bun check` | clean, 838 files |
| `bun check-types` | all six workspaces pass |
| `bun run test` | 1,990 tests pass, 0 fail, 198 files (Default portfolio 252 files) |
| `bun run test:e2e` | 7 E2E files pass, 0 fail |

Interactive smoke in tmux with the fake Provider:

| Flow | Observed result |
| --- | --- |
| Startup, prompt, streamed reply, clean exit | Pass: reply streamed, TUI exited |
| Session picker | Pass: recent Session listed with checkpoint hint |
| Export | Pass: `./smoke-bundle` published with `manifest.json` and `session.jsonl` |
| Import | Pass after fix: re-importing the same bundle reported `already present` and did not duplicate the Session |
| Delete | Pass after fix: picker showed `No matching sessions`, `session-logs/<id>` was removed, and `session-control/deleted/<id>.json` retained identity only |
| Fork/rewind | Not driven by tmux keystrokes; covered by rendered TUI tests `rewind control acts on a valid user checkpoint and warns that files stay unchanged` (`chat-shell.test.tsx`), `the active Session view changes only after the fork publishes`, and `a failed fork keeps the source Session view active and leaves retry state intact` (`session-rewind.test.ts`) |

### Defects found and fixed by the smoke run

1. Bundle import was unreachable from a terminal. The picker bound import to
   `ctrl+i`, which legacy terminals transmit as Tab (0x09), so the handler never
   fired. Import now also accepts `ctrl+o`, and the footer advertises it. Contract
   test: `the Session picker opens bundle import from a key legacy terminals can
   transmit`.
2. Session delete confirmation never completed. Every highlight callback reset
   the pending-delete state, so the second `ctrl+d` re-armed instead of
   confirming; the "ctrl+d again" hint never appeared. Highlighting the same row
   now preserves the pending confirmation. Contract test: `the Session picker
   deletes only after a second confirmation keypress`.

### Observed but not changed

Export and import dialogs show a `./session-bundle` placeholder, but pressing
Enter with an empty field does nothing because the submit handler requires a
non-empty value. Typing the destination works. This is a UX papercut, not a
storage-contract failure; it is recorded here rather than changed in this
ticket.

## 9. Scope

No full-text search, network coordination, workspace rollback, or auto-resume of
interrupted work was added. Tests and receipt handling for earlier slices were
not deferred to this ticket.

## Remaining gaps

- Power-loss behavior and non-tested filesystems/storage stacks remain
  unverified; no claim is made beyond the tested runner paths and process-crash
  recovery.
- Windows coverage is x64 only.
- Fork/rewind was not driven through the tmux smoke; its evidence is the rendered
  TUI control tests and the storage suites listed above.
