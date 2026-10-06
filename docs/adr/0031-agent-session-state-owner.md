# Agent Session ownership boundary across Agent Turns

Status: accepted

Ownership revision: ADR-0035 moves live conversation state to the Stateful Agent in `@wincode/agent-core`; issue #164 moves the transient Submission FIFO and input-lane arbitration there as well. The `AgentSession` class remains the application command and projection boundary, and the prompt, FIFO steering, durable acceptance, continuation, and failure contracts recorded below remain accepted.

The Agent Session is the application-level boundary in `@wincode/coding-agent`.
The Stateful Agent owns the live Session Context, model execution, transient FIFO
Submission Queue, and input scheduling for one loaded conversation. The Agent
Session owns the Session Transcript projection, durable pending/failed Steering
Message ledger, composition and attachment preparation, approvals, compaction
state, and persistence policy; it projects the core-owned queue into the Live
Session Snapshot without maintaining a second queue authority. Agent and Model
selections resolve through Host capabilities when a Submission starts;
mid-turn steering preserves the active execution's selection. The Session Host
opens the session, assembles dependencies, connects persistence, and owns
shutdown as ADR-0023 specifies. It exposes the application boundary as
`agentSession`.

The Agent Session requests each resolved Agent Turn through the Session Host's
`SessionTurnRunner`. The Stateful Agent runs the `AgentRuntime`, which owns the
Model Step and tool loop, continuing while the model requests tools. The fixed 20-step limit is removed: a turn ends when the model
returns without tool calls, or when the run aborts, reaches its existing
deadline, is interrupted, or fails. This revises ADR-0029's prior preservation
of the old step limit. No step-limit completion reason or cross-turn
continuation state is needed.

`prompt(input: SessionSendInput)` admits exactly one new Submission and never
auto-steers: it starts a turn when idle and asks the Stateful Agent to append
the opaque application-prepared payload to its FIFO Submission Queue when busy.
`SessionSendInput` carries `userText`, `files`, explicit `skill` intent, and
`composition`; shared preparation expands Custom Commands once and retains
their expanded prompt while queued. Unsteered queued Submissions remain
transient and are not reconstructed or replayed after restart.

`steer()` is an asynchronous, no-argument command. It returns an explicit
empty-queue or refusal outcome, or an accepted/steered outcome with stable
Submission and message identities. With a queued item, the Stateful Agent
reserves exactly the oldest Queued Submission while the application commits a
distinct user Session Record; core removes the item only after durable success.
The accepted message immediately enters the Session Transcript and Stored
Session History, and a failed commit leaves the queue head available for retry
or Recall. The Agent Session never auto-selects steering for `prompt()` and
does not expose direct-text steering or a compatibility `send()` policy that
chooses lanes automatically.

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
overflow recovery is active. When idle, it asks the Stateful Agent to select
committed pending Steering Messages first, then the oldest Delegation Report,
then the oldest unsteered Queued Submission. The application prepares and runs
the selected input without appending a duplicate user message. With no waiting
input, it resumes only when the last Session Context message is a user message
or a complete retained Tool Call result, and no incomplete Tool Call/result
remains in the context. It runs against the existing context without appending
a user message or executing completed tools again. Other context endpoints
are rejected.

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
