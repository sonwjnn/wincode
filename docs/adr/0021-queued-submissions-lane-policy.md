# Queued submissions are a Session Engine lane policy

A submission that arrives while its session is busy becomes a Queued Submission:
transient Session Engine state that runs as its own Agent Turn when the command
lane frees, never a Session Record until it starts, and never replayed after a
restart. This is the lane policy ADR-0019 anticipated: `send` stays the single
entry point and accepts instead of rejecting while the session is busy.

Status: accepted

Revised 2026-09-19: The steering-lane rejection under "Considered options" is
superseded by ADR-0022, which accepts a Steering Lane delivering inside a
running Agent Turn at a Model Step boundary. Failed Agent Turns now recall the
waiting Steering Lane and Submission Queue instead of draining them; other
terminal Agent Turn outcomes continue to drain the queue FIFO.

## Decision

- While a session is busy — a running Agent Turn or a compaction in flight —
  `send` accepts the submission into the Submission Queue. The queued
  submission carries the composition and the Model Target selection resolved at
  acceptance, and runs unchanged if the selection changes while it waits.
- The Engine drains the queue FIFO, one queued submission per Agent Turn, after
  a terminal Agent Turn outcome other than failure. If a turn fails, it recalls
  all waiting Steering Messages and Queued Submissions to the composer instead.
  Threshold maintenance and overflow recovery apply to each drained turn as
  they do today.
- A user interrupt or cancelled compaction also recalls the whole Steering
  Lane and Submission Queue into the composer. Esc keeps its two-press
  confirmation for the interrupt.
- Recall answers to two gestures. `Alt+Up` (fallback `Alt+Z` where a terminal
  cannot deliver Alt+Arrow) recalls the whole queue; `Shift+Up` recalls only the
  submission that runs next — the oldest waiting one. Recalled submissions
  return to the composer in order, with attachments and pasted text intact; the
  ones left behind keep waiting and drain in order unless the current Agent
  Turn fails, when they are recalled too. Queued items are recorded into prompt
  history at acceptance, so a queue dropped by unmount or quit stays recoverable.
- With a live Agent Turn and an empty composer, Enter promotes the oldest
  queued Submission into the Steering Lane if the head is eligible for steering.
  The transition preserves its message and submission identities and removes
  only that head; the remaining queue stays FIFO. An ineligible head, or a
  queue without a live execution, remains queued and reports why it cannot move.
- The Engine retains a queued submission's attachment ids while it is queued
  and releases them when it leaves the queue, so attachment maintenance can
  never reclaim a queued item's blobs.

This revises the all-at-once recall decision this ADR first recorded: single-item
recall is a second binding, not a replacement, so the whole-queue gesture, its
fallback, and the interrupt path are unchanged.

## Considered options

- **A steering lane (mid-turn delivery)** — rejected: delivery inside a running
  Agent Turn changes Agent Turn semantics and needs its own safety model; this
  design is follow-up-only.
- **Pause-on-interrupt with an explicit resume** — rejected: adds a paused
  state and a resume affordance; recalling the text makes Esc mean one thing —
  stop, and give the user their text back.
- **A durable queued state** — rejected: execution status is runtime state
  (issue-86), the schema deliberately does not persist queued states, and a
  restart must never replay.
- **Single-item recall on its own binding** — rejected at first, on the grounds
  that recalling the whole queue is one action and one key and that granular
  withdrawal is recall-then-edit. Revised 2026-09-18: withdrawing only what runs
  next is worth a second binding, because a user who wants to fix one prompt
  should not have to withdraw the queue and rebuild it by hand. Editing a queued
  submission in place stays rejected — recall-then-submit is the model, and the
  resubmitted text joins the tail of the queue.

## Consequences

- The Session Snapshot gains `queuedSubmissions`, and the send lane's busy
  rejection becomes an acceptance path.
- Interrupt is no longer drain-transparent: it recalls rather than letting the
  queue continue.
- The session view gains a compact queue strip above the composer; the Session
  Transcript stays durable-only, and a queued submission enters it only when it
  starts running. The strip marks the submission that runs next and names both
  Recall gestures.
- The queue is process-local: switching sessions, unmounting, or quitting drops
  it into prompt history; nothing survives a restart.
