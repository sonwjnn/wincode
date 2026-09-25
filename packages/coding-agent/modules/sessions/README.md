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

`SessionSurface` opens the session and renders it: it constructs the Session Host, which loads the transcript and ordered local compaction entries, validates the messages, rebuilds the Session Context around the latest compaction, and constructs the Agent Session with all three. The Host exposes it as `agentSession`, shows the opening state until loading resolves, and hands the open Host to `SessionView`.

### Submit, steer, and continue

The public `AgentSession` API admits accepted prompts while the class remains
the sole long-lived owner and writer of session run state. `input-lane.ts`
coordinates queue and steering-lane transitions; `submission-command.ts`
coordinates one submission and its cancellation. These workflows retain
per-command temporaries only: the owner stores active sends, queue contents,
cancellation state, and Snapshots. Preparation joins in-flight compaction,
resolves settings and attachment budgets, arms and resolves Skills, and
materializes the user message before committing and running the Agent Turn.

`agentSession.prompt(input)` always admits a new user Submission: it starts
when idle and joins the FIFO Submission Queue when busy, preserving its full
composition and attachments. It never converts a prompt into a correction.
`agentSession.steer(text)` explicitly accepts a text-only correction only while
an Agent Turn execution is live. The Agent Runtime consumes Steering Messages
at Model Step boundaries and inserts them before the next model call; the
message is committed when delivered, with the running turn's Agent and Model
Target. A tool-less turn has no later boundary, so its undelivered Steering
Messages become queued submissions ahead of newer prompts.

`agentSession.send(input)` remains the compatibility command: it automatically
steers an active turn, queues when another submission or session command holds
the session, and starts a turn when idle. Retrying a stored message reuses its
identity rather than appending a duplicate user message.

The Agent Session drains queued submissions oldest first after each terminal
Agent Turn outcome, one turn per item. An interrupt or cancelled compaction
recalls the Steering Lane and Submission Queue together to the composer instead
of draining them. Recall restores each complete composition and releases the
attachment blobs held for queued submissions. `Alt+Up` (`Alt+Z` where a
terminal cannot deliver Alt+Arrow) recalls everything; `Shift+Up` recalls only
the next message — the Steering Lane's head when it has one, otherwise the
Submission Queue's head — while the remainder keep waiting. Resubmitting a
withdrawn message joins the tail of the lane selected by the compatibility
`send()` command. Recalled compositions land below the composer's draft, oldest
first.

`agentSession.continue()` rejects while the Agent Session is active or
compacting. When idle, it starts the next waiting Steering Message before the
Submission Queue; without waiting input, it resumes only from a last user
message or a complete retained Tool Call result. It reuses the existing
Session Context: no user message is appended and completed tools are not run
again. Incomplete Tool Calls/results and other context endpoints are rejected.
Overflow recovery uses this context-only continuation after compaction.

The Agent Runtime consumer lives with the Agent Turn it consumes
(`hooks/runtime-turn.ts`), and the Interactive TUI projects its events into
OpenTUI message state.

The Agent Session class is the sole long-lived owner and writer for Session
Transcript, Session Context, admission lanes, approvals, compaction and recovery
attempts, live executions, and operation maps. Focused internal workflows
coordinate input admission and draining, one submission, approval settlement,
and compaction/overflow recovery through narrow callbacks; they retain
per-command temporaries only. The class publishes immutable Snapshots and
ordered events. `AgentSession` exposes commands, Snapshots, and event
subscriptions, never state-write capabilities. The Session Host and Runtime
receive state writes only through the internal `AgentSessionInternalPort`;
`SessionTurnRunner` is the runtime execution port. `useAgentSession` binds an
already-open Host, mirrors its Snapshot in React state, projects approvals into
the panel registry, and never writes session state. The Host opens the session,
constructs the owner, and owns teardown. `isCompacting` and pending approvals
provide the other facts from which `isSessionBusy` is derived.

Each Agent Turn execution owns its own scope. The Agent Session's execution record
carries the identity every observer reads — the Agent Turn Identifier, the
assistant message identity, the source user message, the start time, the Agent,
the Model Target selection and variant, the session-level selection its records
carry, and its own Session View State — while the host scope
(`modules/sessions/turn-execution.ts`) holds what only the mounted surface can
own: the resolved Agent, the armed Skill, the MCP snapshot, the child abort
registry, and delegation bookkeeping. The Snapshot exposes the live view of the
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
Session Command the Agent Session runs: the local Session Compaction module's
per-session in-flight map is the single-flight, so a request joins the
compaction in flight when it carries the same intent — the same trigger and
focus, since a Model Target selection only decides how the summary is
generated — and is refused with a reason when it carries another, and a caller
is never answered with another caller's entry. The Agent Session publishes the
Session Context swap and Compaction entry as part of the command, so an Agent
Turn's preparation settles any compaction in flight before it reads the Session
Context and never sends a context the session has already replaced. Automatic
threshold maintenance and provider-overflow recovery submit the same command.

A provider refusal that reports the context as too large proposes one recovery
for the Agent Turn it ended. The Agent Session keys the attempt to that turn's
original user message, compacts eligible history through it while sanitizing
the interrupted turn, then continues the resulting Session Context without
appending another user message. A later overflow from that continuation uses
the same attempt and is reported as exhausted. Continuation waits for the failed
execution and refuses rather than queueing behind or overlapping user-started
work.

### Approvals

An `ask` Tool Permission reaches the user as an Approval Request the Agent
Session owns. The Tool Gate registers requests through the Host/Runtime-only
`AgentSessionInternalPort`; the binding projects pending requests into the
shared panel registry, which is read-only for the session layer. The panel
requests a settlement, and the resolution it renders is the Agent Session's
own decision.

`respondToApproval` settles one request. Interrupt, abort, and shutdown settle
pending requests through the same internal workflow, so a dismissed panel or
unmount cannot leave a Tool Gate evaluation waiting. Settlement and approval
records remain owned by the Agent Session, not by the workflow or panel.

### Input overlays

`useChatInputController` detects `/` command and `@path` file-mention triggers. The shared
`SelectableList` renders both overlays and supports keyboard selection. The controller resolves
the selected command row — executing a Built-in Command through the app command executor, or
writing a Custom Command (`/name `) or Skill (`/skill:name `) invocation into the input — and
dispatches a typed Built-in Command through that same executor before the view's submit guards.

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
TODO(issue-86): define an explicit retrying runtime state only if retries need
distinct live status from the current Agent Turn.
Queued Submissions are deliberately not persisted: the Agent Session holds them
while busy — see ADR-0021 — and a restart never replays one.


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
reset-oriented. Run `bun run --cwd packages/coding-agent db:push` after changing
`schema.ts`; if Drizzle cannot reconcile the change safely, remove the local
database and attachment directory before restarting Wincode. Keep the
initialization SQL in `client.ts` synchronized with the Drizzle schema.

The reset command only clears session data and is not a schema reset:

`bun run --cwd packages/coding-agent db:reset-sessions`

It removes session records and attachment blobs while preserving prompt
history and workspace/configuration data.

- `submission-types.ts` — immutable Submission inputs, compositions, and outcomes shared by session commands and their consumers.
- `engine/` (Agent Session) — the single class owner of session state and commands. `agent-session.ts` implements the public `AgentSession` API and keeps state-write capabilities in `AgentSessionInternalPort`; `types.ts` defines its Snapshot, internal Ports, `SessionTurnRunner`, and admission outcomes; `submission.ts` prepares and runs submissions.
- `engine/input-lane.ts` — admission, steering, queue draining, fallback, recall, and queued attachment ownership orchestration through Agent Session callbacks.
- `engine/submission-command.ts` — one submission's run/cancellation/deadline ordering; active-send state remains on the owner.
- `engine/maintenance-workflow.ts` — compaction and overflow-recovery orchestration through Agent Session callbacks.
- `engine/approval-workflow.ts` — approval settlement policy; snapshots and settlement maps remain owner-owned.
- `turn-records.ts` — durable Session Records produced by Agent Turns, shared by the Agent Session and runtime consumer.
- `hooks/runtime-turn.ts` — the Agent Runtime consumer: it processes Agent Turn events, owns their live Session View State, and synthesizes missing terminal events.
- `host/session-host.ts` — opens transcript and context, assembles capabilities and the Agent Session, exposes only its public command/snapshot/event API, and owns the Host lifetime. React-free; exported through `@wincode/coding-agent/session-host`.
- `host/session-ports.ts` — `createSessionPorts`: materializes Host capabilities required by the `SessionTurnRunner`, Tools, Tool Gate, Skills, prompt composition, attachments, and persistence.
- `host/use-session-capabilities.ts` — composes Host capabilities from lazy application-provider getters.
- `approval-projection.ts` — projects Agent Session approvals into read-only panel entries.
- `useAgentSession(host)` — binds an open Host to React, mirrors its Snapshot, forwards public commands, and projects approvals.
- `SessionSurface` — the surface that mounts a session: it constructs the Host, renders the opening state until it resolves and the failure when it rejects, and shuts the session down when it unmounts.
- `useChatInputController(options)` — command and file-mention input state.
- `NewSessionView`, `SessionView`, `ChatShell`, `ChatTextArea`, `WaitingMessageStrip` — session UI.
- `SessionsDialog`, `RenameSessionDialog` — session management UI.

## Dependencies

| Module | Used for |
| --- | --- |
| `modules/commands` | slash-command specs, filtering, and execution |
| `modules/file-mentions` | `@path` detection and resolution |
| `modules/connections` | app-owned context and provider dialogs |
| `modules/prompt-settings` | current agent and model |
| `modules/mcp` | local MCP snapshots and tool dispatch |
| `shared/providers` | terminal theme, keyboard, dialogs, and toast state |
