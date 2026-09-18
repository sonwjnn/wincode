# Queued submissions are a Session Engine lane policy

A submission that arrives while its session is busy becomes a Queued Submission:
transient Session Engine state that runs as its own Agent Turn when the command
lane frees, never a Session Record until it starts, and never replayed after a
restart. This is the lane policy ADR-0019 anticipated: `send` stays the single
entry point and accepts instead of rejecting while the session is busy.

Status: accepted

## Decision

- While a session is busy — a running Agent Turn or a compaction in flight —
  `send` accepts the submission into the Submission Queue. The queued
  submission carries the composition and the Model Target selection resolved at
  acceptance, and runs unchanged if the selection changes while it waits.
- The Engine drains the queue FIFO, one queued submission per Agent Turn, after
  each terminal Agent Turn outcome. Threshold maintenance and overflow recovery
  apply to each drained turn as they do today.
- A user interrupt is the exception: interrupting the running turn, or
  cancelling a compaction, recalls the whole queue into the composer instead of
  draining it. Esc keeps its two-press confirmation for the interrupt.
- Recall is all-at-once, bound to `Alt+Up` (fallback `Alt+Z` where a terminal
  cannot deliver Alt+Arrow): the queue returns to the composer in order, with
  attachments and pasted text intact. Queued items are recorded into prompt
  history at acceptance, so a queue dropped by unmount or quit stays
  recoverable.
- The Engine retains a queued submission's attachment ids while it is queued
  and releases them when it leaves the queue, so attachment maintenance can
  never reclaim a queued item's blobs.

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
- **Single-item recall on its own binding** — rejected: recalling the whole
  queue is one action and one key, and granular withdrawal is recall-then-edit.

## Consequences

- The Session Snapshot gains `queuedSubmissions`, and the send lane's busy
  rejection becomes an acceptance path.
- Interrupt is no longer drain-transparent: it recalls rather than letting the
  queue continue.
- The session view gains a compact queue strip above the composer; the Session
  Transcript stays durable-only, and a queued submission enters it only when it
  starts running.
- The queue is process-local: switching sessions, unmounting, or quitting drops
  it into prompt history; nothing survives a restart.
