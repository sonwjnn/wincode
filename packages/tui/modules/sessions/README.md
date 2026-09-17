# Sessions

Chat session lifecycle: creation, messaging, streaming display, compaction, and input handling.

## Flows

### Start a session

`NewSessionView` collects user input and writes the accepted user message as
an ordinary durable Session Record in the local SQLite store.
It then navigates to `/sessions/$id` with transient startup state. That state
starts the first Agent Turn once; opening the same session later only restores
durable records and never runs the Agent.
### Join a session

`SessionView` loads the transcript and ordered local compaction entries, validates the messages, and gives them to the `useSessionEngine` binding as the session's initial Transcript, Context, and compaction entries.

### Send a message

A send is a Session Command the Engine runs. The Engine prepares the
submission — joining the compaction in flight, resolving the compaction
settings and the attachment budget they carry, arming the Skill catalog,
resolving the Skill the submission asks for, and materialising the user
message — commits the accepted user message as its own Session Record, runs the
Agent Turn, and maintains the compaction threshold afterwards. Retrying a
stored message is the same command with a message identity instead of a prompt,
and cancelling, interrupting, and answering an approval are commands too: the
send lane runs one submission at a time, a cancel aborts the one it is running,
and an interrupt ends the turn while keeping the interrupted Tool Call visible.
The Agent Runtime consumer lives with the Agent Turn it consumes
(`hooks/runtime-turn.ts`), and the CLI projects its events into its OpenTUI
message state.

Session state — Session Transcript, Session Context, turn activity, errors,
compaction facts, the approval lifecycle, overflow recovery, and the live
executions — is owned by the React-free Session Engine in
`modules/sessions/engine`. The Engine is the only writer, and it runs every
Session Command, each of which publishes what it produced before it settles.
`useSessionEngine` binds it for rendering: it constructs the Engine from the
TUI-side ports, mirrors its Session Snapshot in React state so the view
re-renders, projects its approvals into the panel registry, and never writes
session state itself. A Session Snapshot carries facts, not a second notion of
"running": `turnActive`, `isCompacting`, and the pending Approval Requests,
with `isSessionBusy` derived from them.

Each Agent Turn execution owns its own scope. The Engine's execution record
carries the identity every observer reads — the Agent Turn Identifier, the
assistant message identity, the source user message, the start time, the Agent,
the Model Target selection and variant, the session-level selection its records
carry, and its own Session View State — while the host scope
(`modules/sessions/turn-execution.ts`) holds what only the TUI can own: the
resolved Agent, the armed Skill, the MCP snapshot, the child abort registry,
and delegation bookkeeping. The Snapshot exposes the live view of the most
recently active execution: a delegated Subagent execution — the same contract
plus its parent linkage — streams in its own view while the parent keeps its
own, and the parent's view returns when the Subagent ends. Delegation
bookkeeping (its executor and child abort registrations) is created with the
execution, so re-rendering cannot reset an in-flight Subagent. The Tool Gate is
session-scoped and consults the execution tree's shared abort index, so an
approval abort cancels the Subagent that owes the call.

The accepted user message is committed before runtime execution begins. Each
completed Tool Call is committed as its own ordinary tool record, and terminal
assistant text is committed as an assistant record. Token and reasoning deltas
remain transient. Failed and cancelled turns commit a safe assistant message;
partial provider output is not durable. Retry is an explicit user action and
reuses the original logical user message without appending a duplicate.

### Compaction

`/compact [focus]` summarizes completed history into a durable local
compaction entry while keeping the full transcript visible. Compaction is a
Session Command the Engine runs: the local Session Compaction module's
per-session in-flight map is the single-flight, so a request joins the
compaction in flight when it carries the same intent — the same trigger and
focus, since a Model Target selection only decides how the summary is
generated — and is refused with a reason when it carries another, and a caller
is never answered with another caller's entry. The Engine publishes the Session
Context swap and the Compaction entry as part of the command, so an Agent
Turn's preparation settles any compaction in flight before it reads the Session
Context and never sends a context the session has already replaced. Automatic
threshold maintenance and provider-overflow recovery submit the same command.

A provider refusal that reports the context as too large proposes one recovery
for the Agent Turn it ended: the Engine records the user message that turn
answers, compacts the replay-safe history — the Session Transcript up to that
message, with the interrupted turn that followed it sanitized away — and
replays the message. The record belongs to the command rather than to a ref a
send can reset: the replayed turn answers the same message, so it cannot chain
into another recovery, the message's later refusals are refused as exhausted,
and a replay the send lane refuses is reported as the compaction error instead
of being queued behind, or overlapped with, a send the user started.

### Approvals

An `ask` Tool Permission reaches the user as an Approval Request the Engine
owns. The Tool Gate registers it through the Engine's approval port and waits
for its one settlement, and the binding projects the Engine's pending requests
into the shared panel registry, which is read-only for the session layer: the
panel asks for a settlement, and the resolution it renders is the Engine's own
decision. `respondToApproval` settles one request, `closeApprovals` settles
every pending request as rejected, and `shutdown` — which the binding runs on
unmount, cancelling the active send as it goes — settles through the same path. Because a request
settles exactly once, a dismissed panel, an abort, or an unmount can never leave
a Tool Gate evaluation waiting, and the one-shot abort latch the binding used to
keep is gone: the second abort trigger finds nothing pending to handle.

### Input overlays

`useChatInputController` detects `/` command and `@path` file-mention triggers. `CommandMenu` and `FileMentionMenu` render the overlays and support keyboard selection.

### Session management

`SessionsDialog` lists local sessions, supports pin/unpin and deletion, and `RenameSessionDialog` updates titles through the same store.

## Storage seam

`storage/` isolates local persistence behind the `SessionStore` interface.
The local Drizzle store persists sessions, ordinary Wincode Session
Records, compactions, and content-addressed attachment blobs. Each
`session_record` row contains one durable user, assistant, or completed
Tool Call message, its semantic outcome, model selection, and live turn
correlation. Primary and delegated rows retain their selection and delegation
metadata; delegated rows remain presentation-identifiable.

Rows are append-only checkpoints. Reopening a session projects primary rows in
storage order and keeps delegated rows grouped after the primary transcript,
then rebuilds model context from successful history and completed Tool Calls.
No execution lifecycle state is persisted, and startup does not reconstruct or
replay an Agent Turn.

TODO(issue-86): define richer durable interrupted-turn metadata only with an
explicit resume/retry contract. Until then, interrupted output is represented
by the safe assistant outcome and retry remains explicit.
TODO(issue-86): design queued execution for busy sessions separately; busy
submissions remain rejected in this lifecycle.
TODO(issue-86): define an explicit retrying runtime state only if retries need
distinct live status from the current Agent Turn.


- `session-store.ts` — store interface and DTOs.
- `get-session-store.ts` — cached local store factory.
- `drizzle-session-store.ts` — Drizzle SQLite implementation.
- `session-record.ts` — record validation and CLI presentation projection.
- `attachment-store.ts` — image blob storage, integrity-checked hydration, compaction projection, and garbage collection.
- `schema.ts` — SQLite schema and durable Session Record/compaction/attachment tables.
- `path.ts` — platform-specific local database and attachment paths.
- `client.ts` — SQLite connection, pragmas, and current-schema initialization.

The database initializes the current `schema.ts` definition on open with
idempotent `CREATE TABLE IF NOT EXISTS` statements. There is no migration
directory or migration history.

## Solo-dev persistence rule

Wincode is maintained by one developer, so schema changes are direct and
reset-oriented. Run `bun run --cwd packages/tui db:push` after changing
`schema.ts`; if Drizzle cannot reconcile the change safely, remove the local
database and attachment directory before restarting Wincode. Keep the
initialization SQL in `client.ts` synchronized with the Drizzle schema.

The reset command only clears session data and is not a schema reset:

`bun run --cwd packages/tui db:reset-sessions`

It removes session records and attachment blobs while preserving prompt
history and workspace/configuration data.

- `getSessionStore()` — local sessions, Session Records, compactions, attachments, and maintenance.
- `SessionOperation` — the Engine's send lane: one application-owned send at a time, with the per-send deadline and the cancel and interrupt reasons.
- `engine/` (Session Engine) — the single owner of one session's live state; observers read Session Snapshots and never write, and it runs every Session Command — submission, compaction, approval settlement, overflow recovery, shutdown. `session-engine.ts` is the factory, `types.ts` the published Session Engine vocabulary (Snapshot, Commands, and Ports), `submission.ts` the Submission Command's pipeline and its preparation, `turn.ts` the Agent Turn projection, and `utils.ts` its pure snapshot, view-state, and busy helpers.
- `turn-records.ts` — the durable Session Records one Agent Turn produces (terminal assistant rows, safe failure and cancellation rows, Tool Call rows), shared by the Engine and the Agent Runtime consumer.
- `hooks/runtime-turn.ts` — the Agent Runtime consumer: it iterates one Agent Turn's events, owns the Session View State they project, and synthesizes the missing terminal event.
- `hooks/session-engine-host.ts` — the TUI-side adapter that supplies the Engine's ports: the Agent Runtime, MCP snapshots and Tools, the Tool Gate, Skill catalogs, prompt composition, attachments, and durable records.
- `approval-projection.ts` — projects the Engine's approvals into the panel registry's read-only entries.
- `useSessionEngine(sessionId, initialTranscript, initialContext)` — binds the Session Engine to React: it constructs one Engine per mounted session, mirrors its Session Snapshot, forwards its commands, and projects its approvals.
- `useChatInputController(options)` — command and file-mention input state.
- `NewSessionView`, `SessionView`, `ChatShell`, `ChatTextArea` — session UI.
- `SessionsDialog`, `RenameSessionDialog` — session management UI.

## Dependencies

| Module | Used for |
| --- | --- |
| `modules/commands` | slash-command specs, filtering, and execution |
| `modules/file-mentions` | `@path` detection and resolution |
| `modules/connections` | direct provider credentials |
| `modules/prompt-settings` | current agent and model |
| `modules/mcp` | local MCP snapshots and tool dispatch |
| `shared/providers` | terminal theme, keyboard, dialogs, and toast state |
