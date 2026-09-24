# Agent Session owns session state across Agent Turns

Status: accepted

The session state owner in `@wincode/coding-agent` is an Agent Session. One
Agent Session owns the Session Context, Session Transcript, Steering Lane,
Submission Queue, approvals, compaction state, and scheduling for one user
session. Agent and Model selections resolve through Host capabilities when a
Submission starts, so selections can change between turns. This renames and
replaces the Session Engine as the sole live state owner; it does not create a
second owner or revisit ADR-0019. The Session Host still opens the session,
assembles dependencies, connects persistence, and owns shutdown as ADR-0023
specifies. It exposes the owner as `agentSession`.

The Agent Session calls `AgentRuntime.run()` for each resolved Agent Turn. The
runtime owns the Model Step and tool loop, which continues while the model
requests tools. The fixed 20-step limit is removed: a turn ends when the model
returns without tool calls, or when the run aborts, reaches its existing
deadline, is interrupted, or fails. This revises ADR-0029's prior preservation
of the old step limit. No step-limit completion reason or cross-turn
continuation state is needed.

`prompt(input)` accepts a new user Submission and returns a started, queued, or
rejected admission. A busy session queues it rather than interpreting it as a
Steering Message; queued compositions retain attachments until the turn starts
or the Submission is recalled. Agent and Model selections resolve when the
Submission starts. `steer(text)` accepts a text-only correction only for a live
Agent Turn execution. If that turn has no later Model Step, the correction is
transferred to the head of the Submission Queue, ahead of newer queued prompts.
The compatibility `send(input)` keeps the historical automatic policy: steer
an active turn, queue behind other busy work, or start immediately when idle.

The Submission Queue remains transient, drains FIFO after terminal outcomes,
and is recalled on interrupt as ADR-0021 specifies. Steering Messages retain
their relative order when moved to the queue. Delegated Subagents remain
executions linked to the same Agent Session. Consumers read immutable Session
Snapshots and ordered events rather than mutating session state directly.
Failure, cancellation, interruption, overflow recovery, and terminal checkpoint
behavior remain in place.

`continue()` rejects while a turn, compaction, queued attachment admission, or
overflow recovery is active. When idle, waiting Steering Messages are moved to
the head of the Submission Queue and the queue's oldest item starts first; an
explicit continuation never overtakes queued work. With no waiting input, it
resumes only when the last Session Context message is a user message or a
complete retained Tool Call result, and no incomplete Tool Call/result remains
in the context. It runs against the existing context without appending a user
message or executing completed tools again. Other context endpoints are
rejected.

Overflow recovery uses the same context-only continuation after compaction
prepares the Session Context. It no longer replays the original user message
through `send()`, preserving the original message identity and single-attempt
policy without appending a duplicate prompt. An overflow history containing
completed Tool Calls remains ineligible for automatic recovery because replay
could repeat side effects. Explicit continuation from complete retained results
is safe because those results are passed as prior context, not re-executed.

Removing the step cap leaves the existing 12-hour deadline on an active send
in place. Cancellation, interruption, operational failure, and deadline
expiration remain terminal paths before a natural model response.
