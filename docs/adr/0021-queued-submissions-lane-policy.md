# Agent Session separates queued Submissions from durable steering

`prompt()` always admits a new Submission: it starts a turn when idle and adds
an uncommitted, transient Queued Submission when busy. `steer()` takes no
arguments and promotes exactly the FIFO head into a durable Steering Message,
committing its user Session Record before acknowledging acceptance. The
Submission Queue remains process-local; committed Steering Messages remain
pending until a safe Model Step consumes them or a later execution resumes them.

Status: accepted

Revised 2026-09-30 for issue #149: this decision supersedes the former
text-only, delayed-commit Steering Lane and the rule that failures recalled
committed steering. The Submission Queue remains transient and Recall-able;
only committed Steering Messages survive restart reconciliation.

## Decision

- `prompt(input)` always admits a new Submission. An idle session starts its
  Agent Turn; a busy session—including one with a running Agent Turn or
  compaction in flight—places the Submission at the tail of the FIFO Submission
  Queue. It never changes the meaning of input into steering. In Interactive
  Mode, Enter on a non-empty composer calls `prompt()`; Enter on an empty
  composer calls `steer()` once. A Queued Submission retains its complete text,
  attachment, Skill, and expanded Custom Command composition while it waits.
- `steer()` has no input payload. If the queue is empty, it accepts no message.
  Otherwise it atomically takes exactly the oldest Queued Submission, preserves
  its Submission and message identities, writes a distinct durable user Session
  Record, and only then reports acceptance. The record immediately enters the
  Session Transcript and Stored Session History; it is no longer Recall-able.
- Each accepted Steering Message remains durable and pending until the Agent
  Runtime prepares and consumes it. The Agent Session preserves the FIFO order
  across messages; a turn ending before consumption leaves them ahead of
  unsteered queued work for a later execution. Several messages accepted before
  one safe boundary remain separate ordered user messages, even if the next
  model request includes them together.
- The current model request and its Tool Call batch finish before pending
  Steering Messages are consumed. Preparation at that safe boundary supports
  attachments and explicit Skill intent, uses the active Agent and Model Target
  without switching the running turn, and uses the same Custom Command
  expansion path as ordinary Submission preparation. A Custom Command's
  expanded prompt is retained and is not expanded or executed a second time.
  Attachment content remains available until the committed message is prepared.
- Preparation or model-request failure marks the blocked Steering Message with
  an observable failure and reason, preserves its committed identity, and stops
  later pending messages from overtaking it. The Agent Session does not blindly
  retry a possibly received request. A deliberate retry reuses the committed
  message and Submission identities; it does not append a duplicate.
- Only uncommitted Queued Submissions can be Recalled. `Alt+Up` (fallback
  `Alt+Z` where a terminal cannot deliver Alt+Arrow) recalls the whole
  Submission Queue; `Shift+Up` recalls only its oldest item. A user interrupt
  or cancelled compaction may recall uncommitted queued work under the existing
  policy, but never removes a committed Steering Message. A failed turn also
  cannot Recall accepted input; unsteered queued work follows the existing
  failure policy.
- Queued items continue to be recorded in prompt history at acceptance as a
  recovery aid, but the process-local Submission Queue is not restored or
  replayed after restart. Restart reconciliation instead discovers committed,
  unread Steering Messages from durable history and retains their identities.
- The Agent Session retains attachment references while a Submission is
  uncommitted and keeps committed attachment content available until
  preparation completes, so storage maintenance cannot reclaim input still
  awaiting processing.

Normal unsteered queued work continues to drain FIFO under the existing
terminal-outcome policy, one Submission per Agent Turn. Durable pending
Steering Messages always precede that work.

The whole-queue and single-item Recall gestures remain separate bindings, but
both withdraw only uncommitted Submissions; an interrupt cannot Recall a
committed Steering Message.

- **Preempting a running model call or Tool Call batch** — rejected: it can
  leave a Tool Call without its matching result. Steering waits for the next
  safe Model Step boundary.
- **One transient lane for all accepted input** — rejected: an unsteered
  Queued Submission is Recall-able and may disappear on restart, while a
  committed Steering Message is durable, not Recall-able, and must be
  reconciled before later work.
- **Persisting the entire Submission Queue** — rejected: unsteered work remains
  process-local and must never be replayed after restart. Only a Submission
  explicitly accepted by `steer()` becomes durable.
- **Editing a Queued Submission in place** — rejected: Recall-then-submit keeps
  editing separate from admission; the resubmitted input joins the queue tail.
- **Automatically retrying a failed steered request** — rejected: the request
  may already have received input or caused effects. Failure blocks later
  pending messages until an explicit retry reuses the existing identity.

## Consequences

- The Live Session Snapshot and session view expose both uncommitted queued
  Submissions and committed pending/failed Steering Messages with stable
  identities and status.
- The Session Transcript includes each steered user message as soon as its
  durable commit succeeds; it does not wait for Model Step delivery. A queued
  but unsteered Submission remains outside durable history.
- Recall gestures apply only to uncommitted queued input. Failure and interrupt
  cannot silently withdraw committed Steering Messages.
- The Submission Queue remains process-local and is not replayed after restart.
  Durable accepted-but-unread Steering Messages are reconciled from stored
  history without reconstructing the interrupted Agent Turn or duplicating
  their records.
