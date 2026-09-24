# Steering Messages deliver inside the running Agent Turn

A user who sees an Agent Turn heading the wrong way can correct it without
waiting for that turn to end, and without stopping it. A Steering Message is a
second accepted-input lane beside the Submission Queue: it is delivered to the
model at the next Model Step boundary inside the running Agent Turn, and it
becomes a Session Record the moment it is delivered. This supersedes the
"steering lane (mid-turn delivery)" rejection ADR-0021 recorded; the rest of
that ADR — the Submission Queue, its drain boundary, and Recall — stands
unchanged.

Status: accepted

Runtime-mechanism note: [ADR-0029](0029-own-model-protocols-and-agent-runtime.md) replaces the AI SDK step hook with a Wincode-owned Model Step boundary. Steering delivery semantics remain unchanged; references below to the AI SDK describe the earlier implementation.

## Decision

- The Engine gains a Steering Lane beside the Submission Queue. `send` stays the
  single entry point: it admits a submission to the Steering Lane while an Agent
  Turn is running, and to the Submission Queue when the session is busy any
  other way.
- A Steering Message is delivered at a Model Step boundary: the current Model
  Step and its Tool Call batch finish, then the message joins the Session
  Context before the next model call. Nothing interrupts a model call in
  flight, so a Tool Call is never torn from its request.
- A Steering Message carries text only. It cannot carry attachments, invoke a
  Skill or Custom Command, or change the Agent, and the composer refuses those
  while a turn is running — no half-armed Skill catalog or Tool set can exist
  inside a turn.
- Delivery commits a Session Record, and the message enters the Session
  Transcript as a user message. `sourceUserMessageId` keeps the meaning Overflow
  Recovery and retry already depend on — the message the execution started from
  — and the Engine marks the delivered message's Agent Turn in its own metadata
  instead of re-pointing that field.
- A tool-less Agent Turn runs exactly one Model Step, so it has no boundary to
  deliver at. A Steering Message accepted during one waits in the Submission
  Queue instead.
- Recall withdraws the Steering Lane and the Submission Queue together, and the
  queue strip shows both, marking the submission that runs next apart from the
  messages waiting to steer.

## Considered options

- **Preempting the running model call** — rejected: a model call interrupted
  mid-stream leaves Tool Calls without a valid request/result pair, and the
  delivery hook available at this boundary only runs between steps, so
  preemption would mean reimplementing the step loop the Agent Runtime adapter
  delegates to the AI SDK.
- **Delivering through the Submission Queue** — rejected: the two lanes deliver
  at different points, so one queue would give every waiting submission a
  meaning its neighbours do not share, and the drain invariants ADR-0021 fixed
  would have to be rewritten rather than kept.
- **Re-arming Skill and tools per step** — rejected: it needs a per-step record
  of which Tool set is live — the safety model ADR-0021 named as the price of a
  steering lane — and course correction does not need it.
- **Re-pointing `sourceUserMessageId` at the newest input** — rejected: it moves
  the anchor Overflow Recovery replays from, splits a Tool Call that spans the
  delivery point across two turns, and still needs the original message kept
  somewhere else.
- **Attachments on a Steering Message** — rejected: attachment hydration runs
  once, at turn start, against a budget computed there, so a mid-turn message
  would need a second hydration against a budget already spent.

## Consequences

- The Agent Runtime adapter starts using the AI SDK step hook it currently
  leaves unset. The AI SDK stays behind that boundary; no AI SDK type crosses
  it.
- The Session Command invariant now admits a Command that lands inside a running
  Agent Turn. An Agent Turn answers more than one input, so the transcript has
  to distinguish the user messages that opened a turn from the ones that joined
  one.
- The `mid-turn` compaction trigger reason, `midTurnEnabled`, and
  `midTurnAvailable` are removed. Nothing produced them, and a trigger named
  after its timing sits wrong in a set named after causes (`manual`,
  `threshold`, `overflow`) — the case they were staged for is a `threshold`
  check that runs between Model Steps, exactly as Pi names it.
