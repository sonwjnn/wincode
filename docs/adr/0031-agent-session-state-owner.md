# Agent Session owns session state across Agent Turns

Status: accepted

The session state owner in `@wincode/coding-agent` is an Agent Session. One
Agent Session owns the Session Context, Session Transcript, committed pending
and failed Steering Messages, transient Submission Queue, approvals, compaction
state, and scheduling for one user session. Agent and Model selections resolve
through Host capabilities when a Submission starts; mid-turn steering preserves
the active execution's selection. This keeps one live state authority while
revising the input and delivery policy in ADR-0021 and ADR-0022. The Session
Host still opens the session, assembles dependencies, connects persistence, and
owns shutdown as ADR-0023 specifies. It exposes the owner as `agentSession`.

The Agent Session calls `AgentRuntime.run()` for each resolved Agent Turn. The
runtime owns the Model Step and tool loop, which continues while the model
requests tools. The fixed 20-step limit is removed: a turn ends when the model
returns without tool calls, or when the run aborts, reaches its existing
deadline, is interrupted, or fails. This revises ADR-0029's prior preservation
of the old step limit. No step-limit completion reason or cross-turn
continuation state is needed.

`prompt(input: SessionSendInput)` admits exactly one new Submission and never
auto-steers: it starts a turn when idle and joins the FIFO Submission Queue
when busy. `SessionSendInput` carries `userText`, `files`, explicit `skill`
intent, and `composition`; shared preparation expands Custom Commands once and
retains their expanded prompt while queued. Unsteered queued Submissions remain
transient and are not reconstructed or replayed after restart.

`steer()` is an asynchronous, no-argument command. It returns an explicit
empty-queue or refusal outcome, or an accepted/steered outcome with stable
Submission and message identities. With a queued item, it atomically takes
exactly the oldest Queued Submission, commits a distinct user Session Record,
and reports acceptance only after the durable commit. The accepted message
immediately enters the Session Transcript and Stored Session History. The
Agent Session never auto-selects steering for `prompt()` and does not expose
direct-text steering or a compatibility `send()` policy that chooses lanes
automatically.

Every committed Steering Message has observable durable pending/failed
processing state. Acceptance is not tied to a narrow Model Step window: a busy
Agent Session may commit input while preparing or settling, and it remains
pending if the active turn ends before it can be consumed. Restart
reconciliation resumes it without reconstructing the old Agent Turn or
appending a duplicate. Accepted messages are processed FIFO ahead of
still-unsteered queued work. At the next safe Model Step boundary, preparation
supports attachments and explicit Skill intent without changing the active
Agent or Model Target. Several messages remain separate ordered user messages
even when one model request reads them together.

Custom Command expansion uses the same shared Submission preparation as
ordinary input and is not repeated on delivery or retry. Attachment content
remains available until its message is prepared; attachment hydration and
budget are refreshed for the next Model Step.

Preparation or model-request failure records an observable failure and reason
on the blocked committed message, preserves its identity, and stops later
pending input from overtaking it. The Agent Session does not blindly retry a
possibly received request. A deliberate retry reuses the same committed
message and Submission identities and appends no duplicate record. Recall and
interrupt can return only uncommitted queued Submissions; committed Steering
Messages are never withdrawn.

One-shot callers preserve their await-to-terminal behavior with an explicit
completion/wait path after Submission admission. That path does not restore
automatic lane selection or turn a busy Submission into a Steering Message.

`continue()` rejects while a turn, compaction, queued attachment admission, or
overflow recovery is active. When idle, it resumes committed pending Steering
Messages first, in order and without appending another user message; only then
does the oldest unsteered Queued Submission start. With no waiting input, it
resumes only when the last Session Context message is a user message or a
complete retained Tool Call result, and no incomplete Tool Call/result remains
in the context. It runs against the existing context without appending a user
message or executing completed tools again. Other context endpoints are
rejected.

Overflow recovery uses the same context-only continuation after compaction
prepares the Session Context. It no longer replays the original user message
through `send()`, preserving the original message identity and single-attempt
policy without appending a duplicate prompt. A committed Steering Message
retains its identity through this recovery and is not duplicated. An overflow
history containing completed Tool Calls remains ineligible for automatic
recovery because replay could repeat side effects. Explicit continuation from
complete retained results is safe because those results are passed as prior
context, not re-executed.

Removing the step cap leaves the existing 12-hour deadline on an active send
in place. Cancellation, interruption, operational failure, and deadline
expiration remain terminal paths before a natural model response.
