# Steering Messages deliver inside the running Agent Turn

A user can steer an active Agent Turn without waiting for it to end or stopping
it. Each no-argument `steer()` takes exactly the oldest Queued Submission,
commits a distinct durable user Session Record before acknowledging acceptance,
and leaves it pending for processing at a safe Model Step boundary. It is not a
second transient accepted-input lane: this supersedes ADR-0021's former
text-only/delayed-commit promotion and Recall behavior.

Status: accepted

Runtime-mechanism note: [ADR-0029](0029-own-model-protocols-and-agent-runtime.md) replaces the AI SDK step hook with a Wincode-owned Model Step boundary. Steering delivery semantics remain unchanged; references below to the AI SDK describe the earlier implementation.

## Decision

- `prompt()` always admits a new Submission and never steers: it starts a turn
  when idle and queues when busy. Steering is the separate no-argument
  `steer()` command. An empty queue yields no accepted message; otherwise one
  call atomically promotes exactly the oldest Queued Submission and commits it
  before success is reported.
- Each steered Submission becomes its own durable user Session Record and enters
  the Session Transcript immediately, not at delivery. Submission and message
  identities remain stable through pending processing, failure, and deliberate
  retry. Acceptance is not tied to a narrow Model Step window: a busy session
  may commit input while the Agent Session is preparing or settling, and the
  message remains pending until a safe boundary. A committed message is never
  Recall-able.
- The running model request and its Tool Call batch finish before the Agent
  Runtime consumes pending messages at a safe Model Step boundary. All messages
  accepted before that boundary remain distinct and ordered in the next model
  request. The current Agent and Model Target remain fixed for that Agent Turn.
- Shared Submission preparation supports text, attachments, explicit Skill
  intent, and expanded Custom Command prompts. Custom Commands expand once
  through the same preparation path as ordinary input and retain their expanded
  prompt while queued; delivery and retry do not repeat the expansion.
  Attachment hydration and budget are refreshed for the new Model Step, and
  explicit Skill context is prepared for the message without switching the
  active Agent or broadening its Tool Permission. Built-in UI control Commands
  remain controls, not user-message Submissions.
- A preparation failure or model-request failure marks the blocked message
  with an observable status and reason, preserves it durably, and stops later
  pending messages from overtaking it. No uncertain request is blindly retried.
  A deliberate retry uses existing identities and does not append duplicate
  user messages.
- If the Agent Turn ends before consuming accepted messages, they remain
  pending in FIFO order ahead of unsteered queued work and are reconciled by a
  later execution. Restart reconciliation processes committed unread messages
  without reconstructing the old Agent Turn.
- Recall withdraws only uncommitted Queued Submissions. It cannot remove a
  committed Steering Message, including on interrupt or failed-turn recovery.
- Every completed Model Step is a steering boundary, including a text-only
  response without Tool Calls. Pending Steering Messages keep the same Agent
  Turn running for another model call when that execution remains active.

## Considered options

- **Preempting the running model call or its Tool Call batch** — rejected: it
  can leave a Tool Call without its matching result. Pending input waits for a
  safe Model Step boundary.
- **Committing only when the message is delivered** — rejected: a successful
  steer must be durable before it is acknowledged, and a turn may end before
  delivery. The durable pending message is reconciled rather than recalled or
  duplicated.
- **Treating every steered message as a new independent turn** — rejected while
  the current Agent Turn can continue: it would delay a requested correction
  and change turn semantics. If the current turn ends first, pending input is
  processed by the next execution without changing its identity.
- **Merging several steered messages into one user message** — rejected:
  separate records preserve distinct user intent and FIFO identity even when a
  single model request reads them together.
- **Rebuilding the active Agent or Model Target for each steered message** —
  rejected: mid-turn input prepares only its content and explicit Skill intent;
  it does not silently change the running execution's selection.
- **Reusing a spent attachment budget for mid-turn hydration** — rejected:
  attachment preparation refreshes its budget at the next Model Step boundary.

## Consequences

- The Agent Runtime consumes a FIFO of durable pending user messages at its
  Model Step boundary; this is processing state, not a second transient
  acceptance lane.
- The Session Transcript and Stored Session History reflect a successful steer
  before the model reads it. Live and persisted observation expose stable
  message/Submission identities and pending or failed status.
- A preparation or request failure blocks later pending input and requires
  deliberate retry; a possibly received model request is never replayed blindly.
- The Session Command invariant admits steering during a running Agent Turn,
  while preserving its active Agent and Model Target. An Agent Turn may process
  multiple distinct user messages without merging their Transcript records.
- Steering and Recall have different durability boundaries: only uncommitted
  queued Submissions return to the composer.
