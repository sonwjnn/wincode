# Domain Context

## Connection Provider

A Connection Provider defines how the CLI authenticates with an AI provider.
It owns supported connection methods, credential validation, credential lifecycle,
and the minimal authorization material required to invoke that provider.

Connection Providers are statically integrated into the codebase. They are not
runtime plugins and do not own model catalog entries, model capabilities, or
model variants.

## Connection

A Connection is a validated, securely persisted credential for one Connection
Provider. Replacing a Connection must not remove the previous credential until
the replacement has passed validation and can be committed atomically.

Consumers receive only the minimal authorization material needed for a provider.
Stored credential details such as refresh tokens remain inside the Connections
module.

New credential storage formats do not migrate existing Connections. A new
storage namespace is used so existing records remain untouched for rollback,
while users reconnect providers into the new format.

## Model Catalog

The Model Catalog is the static product definition of supported models and
their Effort and Reasoning Mode capabilities. It references a Connection
Provider by ID but does not own credentials or authentication behavior.
An entry that remains in the catalog but is no
longer selectable is retired rather than deleted, so existing Session Records
keep their model identity. A deliberate clean-cutover prune MAY delete legacy
IDs after the corresponding persisted data is reset; the 2026-09 prune used
that exception.
_Avoid_: pricing table, provider model list, discovery

**Model Lifecycle**:
Whether a Model Catalog entry may be selected for a new turn: `active` or
`retired`. Retirement is a product decision, independent of whether the
provider still serves the model. _Avoid_: deprecation, availability

**Effort**:
A named reasoning level advertised by a Model Catalog entry. Each model supports
its declared subset; an Effort describes a level, not whether reasoning is
enabled. _Avoid_: thinking level, variant

**Effort ID**:
The stable identifier of an Effort that a Session may retain and restore. It
identifies the chosen level, not a model's capability or the provider-specific
request generated from that choice. _Avoid_: variant ID

**Reasoning Mode**:
A non-effort reasoning choice a model supports through its toggle: `none`
requests reasoning off; `thinking` requests it on without a named Effort. _Avoid_:
effort, thinking level, variant

**Model Descriptor**:
A Model Catalog entry together with where its metadata came from and whether
that metadata is current. This is the shape a reader resolves; the entry itself
stays immutable. _Avoid_: model record, merged model

## Model Target

A Model Target is the effective Connection Provider, model, Effort, Reasoning
Mode, and minimal authorization selected for one Agent Turn. It is transient and
must not become a Session Record. _Avoid_: provider SDK model handle, persisted model handle

## Model Protocol

The provider-facing request and stream dialect used to invoke a Model Target.
One Connection Provider can serve models through multiple Model Protocols;
OpenCode Go is one such Connection Provider. _Avoid_: SDK, Connection Provider

## Session Selection

The last-used Agent, Model, and reasoning choice—an Effort or Reasoning Mode—
recorded in a session's message metadata, resolved when a session opens or a turn
is sent. Two tiers are recorded on write and merged on read: the session row holds
session-level choice (the user's prompt-config selection), and message
metadata holds the effective selection (what a turn actually ran with,
including Agent pins). Restore reads leniently (a selection survives partially
broken metadata); the request body reads it strictly (only schema-valid pairs
reach the send). Sources merge in a fixed order — session row, then message
metadata, then prompt-config refs. _Avoid_: chat config, latest config

## Session Execution

**Stateful Agent**:
The in-memory runtime of one loaded conversation, including a delegated conversation, across multiple Agent Turns. It can keep running without an open UI, while an idle conversation can be unloaded and later restored from durable history. It owns live conversation state, tool execution, lifecycle events, approval settlement, and steering/follow-up scheduling; durable history and coding-specific policies remain outside it. _Avoid_: one Agent Turn, Session Store

**Delegated Conversation**:
A separately identified, durable Session created for a Subagent's delegated work, linked to its parent Session and Tool Call. It can continue without a visible UI, be opened to observe its live execution, and accept the user's Submissions through its own Stateful Agent like a parent Session; a successful delegated task is reported only through an acknowledged `submit_result`. _Avoid_: branch of the parent's transcript, transient Subagent execution

**Delegated Task**:
The specific work a parent assigns to a Delegated Conversation, identified independently of that child's Session ID and later user Submissions. Successful completion requires the child to submit its result explicitly; simply ending a turn does not report success. The child conversation may continue afterward. _Avoid_: entire child session, every child turn

**Delegation Report**:
The durable success, failure, or cancellation outcome of one Delegated Task, correlated with its parent Tool Call and child Session. It becomes ordinary parent input at a safe active-turn boundary or an automatic idle continuation; it never interrupts in-flight model or Tool Call work. _Avoid_: user prompt, raw child transcript

**Delegated Task Status**:
The observable state of one assigned task, distinct from whether its child Session is open. A task has one confirmed terminal outcome; after an unclean shutdown without confirmation, its outcome is interrupted or unknown, not assumed cancelled. _Avoid_: child Session lifetime, live stream event

**Delegation Cancellation**:
An explicit tool action the parent Agent may choose to stop one delegated task or all active descendant tasks without aborting its own turn. A user prompt does not itself cancel child work, and cancellation does not delete child Sessions or their history. _Avoid_: automatic cancellation on parent prompt, closing a child Session

**Agent Session**:
The application-level conversation boundary that connects the Stateful Agent to durable session history and coding-specific policies. It does not independently own a second copy of the live runtime state. _Avoid_: Stateful Agent, Session Store

**Session Host**:
The application-level composition that opens one Session and connects its Stateful Agent to session capabilities. Its lifetime is independent of which conversation the UI displays; it may release an idle runtime without deleting durable history. _Avoid_: UI view, Session Store, Stateful Agent

**Session Writer**:
The single live authority to write one Session ID, even when both delegation and a user submit input to it. Multiple callers may send commands through that authority, but another writable runtime for the same Session ID cannot run concurrently. _Avoid_: one input source, Session Lease, workspace writer

**Session Command**:
A request to change a Session, including prompting, steering, interruption, approval settlement, compaction, or overflow recovery. The Stateful Agent orders live execution; the coding application coordinates maintenance and persistence with it. _Avoid_: event, background task

**Compaction Intent**:
What one compaction request asks for: its trigger and its focus, as distinct from the messages it runs over and the Model Target selection its summary is generated with. The Session Compaction module admits a request that carries the intent already in flight and refuses one that carries another, so no caller is answered with another caller's entry while two threshold passes, which share an intent, still meet in one operation. _Avoid_: compaction request, compaction options

**Overflow Recovery**:
The one recovery a context-overflow refusal buys for the Agent Turn it ended: the Agent Session compacts eligible history through that turn's original user message, sanitizes the interrupted turn, then continues the resulting Session Context without appending another user message. The attempt stays keyed to the original message, so its continuation cannot chain another recovery and no new send can reset it. _Avoid_: retry, resend

**Approval Request**:
One Tool Permission `ask` awaiting a decision. The Stateful Agent owns it through exactly one settlement; a request from a background child remains associated with that child Session and is signaled across sessions so a user can find and decide it. The coding application owns permission policy and presentation. _Avoid_: global approval without Session identity, approval prompt

**Live Session Snapshot**:
The immutable view of one Stateful Agent's current conversation and transient execution state, including uncommitted waiting Submissions, committed Steering Message status, and approvals. Observers receive it from the live owner, never from persisted history alone. _Avoid_: Session Snapshot, Stored Session History, state dump

**Stored Session History**:
The committed Session Records and compactions read from storage without opening a Session Host, including the durable status needed to reconcile accepted-but-unread Steering Messages. It excludes in-flight output and transient state, and reading it grants no authority to run Session Commands. _Avoid_: Live Session Snapshot, live transcript, session owner

**Session Transcript**:
The ordered messages a session presents to the user. A steered Submission enters the Transcript when its durable record is committed, before the Agent Turn processes it; an unsteered Queued Submission does not. Compaction summaries stay out of the Transcript even when they are part of the Session Context. _Avoid_: chat history, display messages, message log

**Session Context**:
The messages a session sends to the model for its next Agent Turn. It is derived from the Session Transcript through compaction and interruption sanitation, so the two can differ. _Avoid_: active messages, prompt history, context window

**Agent Turn Execution**:
One run of an Agent Turn with its identity, model selection, live view and turn-scoped capabilities. A delegated execution belongs to its own Stateful Agent and Delegated Conversation, retains its parent Turn and Tool Call linkage, and does not share the parent's model context. _Avoid_: conversation runtime, current turn

**Session View State**:
The live, transient projection of one Agent Turn Execution for its conversation's UI. It is distinct from the Session Record and from another execution's view, including the parent execution of a delegated conversation. _Avoid_: streaming state, live buffer

**Submission**:
An input unit admitted by a session: user-authored text, attachments, pasted text, explicit Skill intent, or a Custom Command invocation with its expanded prompt. _Avoid_: message, request

**Queued Submission**:
A busy session's accepted Submission that has not started a turn or been steered. It remains uncommitted, retains its composition, can be Recalled, and is process-local rather than replayed after restart. _Avoid_: queued prompt, pending message, backlog item, Steering Message

**Submission Queue**:
The FIFO order of uncommitted Queued Submissions exposed in the Live Session Snapshot. `prompt()` always admits a new input and never steers; `steer()` takes exactly the oldest item and commits it as a Steering Message. Unsteered work follows the existing drain/Recall policy; committed Steering Messages keep priority, and Delegation Reports precede unsteered Queued Submissions. Committed Steering Messages cannot be recalled. _Avoid_: message queue, follow-up list, outbox

**Recall**:
Withdrawing uncommitted Queued Submissions back into the composer in order, restoring their composition instead of running them. Recall never removes or changes a committed Steering Message. _Avoid_: dequeue, withdraw, unsend, retract, delete

**Steer**:
A no-argument session command that takes exactly the oldest Queued Submission, if one exists, and commits it as a distinct durable user message before reporting acceptance. With no queued Submission it accepts no message; it never accepts replacement text or an arbitrary message payload. _Avoid_: auto-steer, direct-text steer, promote-only

**Steering Message**:
A durable user Session Record created when `steer()` accepts a Queued Submission. Its message and Submission identities remain stable while it is pending, processed, failed, or deliberately retried; a committed message is not Recall-able. _Avoid_: transient interjection, lane-only message, mid-turn message

**Steering Lane**:
The FIFO order of committed Steering Messages awaiting processing at a safe Model Step boundary or a later execution. Their durable pending or failed status is observable and survives restart reconciliation; a failed head blocks later pending messages until deliberate retry, never blind replay. _Avoid_: transient steering queue, interjection lane

## Agent Session API

**Agent Continuation**:
The resumption of an idle Agent Session without a caller-supplied Submission. It processes committed pending Steering Messages first, then Delegation Reports, then uncommitted Queued Submissions; with no waiting input, it resumes only from a last user message or a complete retained Tool Call result. It appends no duplicate user message and does not rerun completed tools. Incomplete Tool Calls/results and other context endpoints are rejected. Overflow recovery uses this context-only path after compaction. _Avoid_: retry, resend, new prompt

## Language

**Diagnostic Log**:
A persistent, non-user-facing record of Wincode runtime diagnostics. It is distinct from Execution Mode output, CLI Command output, and the JSON Event Stream. _Avoid_: CLI output, protocol event, session transcript

**Wincode CLI**:
The user-facing command-line entry point for the Coding-Agent Application. A bare invocation selects Interactive Mode; `--mode` or `-m` selects another Execution Mode by its full name, and `--prompt` or `-p` supplies one-shot input. It does not own Agent or Session state. _Avoid_: Wincode TUI, command dispatcher

**Coding-Agent Application**:
The user-facing Wincode application that runs an Agent through Interactive, Print, JSON, or RPC Mode. It owns application lifetime and active conversation runtimes independently of the currently displayed view; Stateful Agents own their respective live state. _Avoid_: Wincode TUI, CLI package, agent core

**Execution Mode**:
A user-facing way to run the Coding-Agent Application. Each mode chooses input, output, and process lifecycle but does not own Session state. _Avoid_: Coding Mode, agent loop

**Interactive Mode**:
The terminal interface through which users conduct Wincode sessions. It is the default mode of a bare `wincode` invocation. _Avoid_: Wincode TUI, TUI application, CLI

**Print Mode**:
A one-shot mode that opens or creates one One-Shot Session, accepts exactly one Submission from CLI input, and streams human-readable assistant text to stdout. It waits while delegated tasks run; an idle child still awaiting an explicit report ends the invocation with an error, leaving its Session available to reopen. _Avoid_: text mode, batch mode

**JSON Mode**:
A one-shot mode that opens or creates one One-Shot Session, accepts exactly one caller Submission, and emits structured Agent Turn events as JSONL rather than JSON-RPC frames. It identifies child events by Session; an idle child still awaiting an explicit report ends the invocation with an error. _Avoid_: JSON-RPC mode, RPC

**One-Shot Session**:
The durable Session opened or created for one Print Mode or JSON Mode invocation. It accepts one caller Submission and persists afterward; active delegated tasks must settle before exit, while an idle task awaiting a result remains persisted and causes an explicit error rather than automatic replay. _Avoid_: ephemeral session, batch session

**Invocation Selection**:
The Agent, Model, Effort, and Reasoning Mode resolved for one Print Mode or JSON Mode invocation. Explicit CLI selectors override a Session Selection; omitted selectors restore it or use configuration, and creating a One-Shot Session requires complete resolution before its first record. _Avoid_: command-line config, request selection

**JSON Event Stream**:
The ordered public Agent Turn events emitted by JSON Mode as JSONL, including identified child-Session events and terminal outcomes for delegated work. It uses the same event vocabulary as RPC Mode but has no JSON-RPC envelopes, commands, or state notifications. _Avoid_: raw Live Session Snapshot, JSON-RPC stream

**Non-Interactive Approval**:
A Tool Permission `ask` encountered by Print Mode or JSON Mode. Without explicit auto-approval it fails closed rather than waiting; `--auto` may allow ordinary asks, while safety asks and explicit denies remain blocked. _Avoid_: unattended approval, automatic permission

**RPC Mode**:
A long-lived JSON-RPC 2.0/JSONL Execution Mode with one active Session as the default command and realtime event target. Switching the active Session changes the client's view without stopping other running conversations; a child can be opened and used like a parent, while input/steering semantics remain the same as Interactive Mode. _Avoid_: JSON Mode, one-runtime-per-process RPC

**CLI Command**:
A user-invoked operation that is not an Execution Mode, such as help, version, or a future administrative command, dispatched by Wincode CLI. It may complete without running an Agent. _Avoid_: Execution Mode, Built-in Command, slash command

**Line Range**:
A 1-indexed, inclusive selection of consecutive lines in a text file. Multiple
Line Ranges in one ordered selection collapse when they overlap or are adjacent.
_Avoid_: line slice, offset window

**Line Range Selector**:
The optional part of a Read Tool target that names one or more Line Ranges.
When a complete target also names an existing literal file, the literal file
takes precedence over interpreting its suffix as a Line Range Selector.
_Avoid_: pagination, read offset

**Line Range Edit**:
An Edit Tool operation that replaces or deletes one Line Range. Its replacement
content is independent of the number of selected lines.
_Avoid_: multiline edit, line slice edit

**Range Revision**:
A compact proof of the complete content of one Line Range at observation time.
It becomes stale when any line inside that range changes, but is unaffected by
changes outside the range. _Avoid_: endpoint hash, file version

**File Version**:
A content-derived identifier for one complete state of a file. Reads of unchanged
content return the same File Version; an Edit Tool operation uses it to identify
the snapshot on which its addresses and observations were based.
_Avoid_: tag, revision counter, read ID

**File Snapshot**:
The exact content of a file identified by a File Version and retained so an
Edit Tool operation can interpret addresses from an earlier observation.
_Avoid_: backup, current file

**Seen Lines**:
The complete file lines actually returned to an Agent for one File Snapshot.
Lines omitted or truncated from tool output are not Seen Lines.
_Avoid_: requested lines, readable lines

**File Observation**:
A session-scoped association between a canonical file identity, one File Version,
and the Seen Lines returned from that version. It records what an Agent observed,
not merely what the Read Tool accessed. _Avoid_: File Snapshot, read result

**Edit Mode**:
A named Edit Tool strategy with its own addressing and verification contract.
Choosing an Edit Mode changes how a target is identified and validated, not the
user-visible intent to modify content. _Avoid_: edit type, fallback level

**Edit Hunk**:
One contiguous replacement, deletion, or insertion within an Edit Tool
operation. Multiple Edit Hunks in one operation are resolved before any is
applied. _Avoid_: edit, diff chunk

**Edit Section**:
The path, File Version, and ordered Edit Hunks for one file in a multi-file
Edit Tool operation. _Avoid_: file patch, patch file

**Full Diff Artifact**:
The complete human-readable diff of an Edit Tool operation, retained outside
inline tool output when that output would exceed its display budget. It supports
audit and continuation, not verification or rollback. _Avoid_: File Snapshot,
recovery artifact

**Recovery Artifact**:
An immutable manifest and retained original content used to reconcile paths left
unresolved by a failed multi-file mutation. It remains pinned until reconciliation
or explicit destructive discard. _Avoid_: Full Diff Artifact, File Snapshot

**Unresolved Recovery**:
A persistent workspace state created when a mutation cannot prove that every
affected path was committed or restored. Coding-tool mutations of those paths
remain blocked until explicit reconciliation or destructive discard.
_Avoid_: failed edit, stale lock

**Built-in Command**:
A fixed UI control the CLI ships with, dispatched by kind to an adapter
(`/new`, `/models`, `/exit`). It is not a user-message Submission. _Avoid_: Command, slash command

**Custom Command**:
A user-defined prompt template whose invocation expands once into Submission content through shared input preparation. Its expanded prompt remains part of the Submission when queued or steered and is not re-executed during delivery or retry. _Avoid_: Command, slash command

**Skill**:
A named set of instructions that augments an Agent for one Agent Turn. Skill context is untrusted and turn-scoped; explicit Skill instructions have higher authority than Agent-loaded Skill instructions, but neither can override Wincode safety, Tool Permission, direct user intent, or Project Instructions. _Avoid_: Agent, session mode, Custom Command

**Skill Activation**:
The selection of a Skill for the current user turn. Activation does not persist to later turns. _Avoid_: Skill installation, session Skill

**Project Instruction**:
Repository-provided guidance associated with the active workspace and loaded for an Agent Turn with source provenance. Farther-ancestor sources precede nearer sources, and the nearer source takes precedence. Project Instructions rank below active Agent instructions and above Skill instructions; they cannot override Wincode safety, Tool Permission, or direct user intent. _Avoid_: treating repository text as unrestricted authority

**Instruction Source Precedence**:
The ordering used to combine multiple Project Instruction sources: a farther ancestor precedes a nearer source, and the nearer source takes precedence. It does not determine authority between Project Instructions and other instruction categories.

**Instruction Authority**:
The fixed precedence between instruction categories: Wincode safety and Tool Permission, direct user intent, active Agent instructions, Project Instructions, explicit Skill instructions, then Agent-loaded Skill instructions. Lower-authority context cannot override higher-authority context.

**Agent**:
A named AI behavior that can lead a session, execute a delegated task, or
both. Its role and tool permissions are separate concerns. _Avoid_: Coding Mode,
persona

**Agent Turn**:
One Primary Agent or Subagent processing one input through any number of Model
Steps and Tool Calls until completion, failure, or cancellation. _Avoid_: request,
run, chat turn

**Interrupted Agent Turn**:
An Agent Turn whose execution stopped before completion, failure, or cancellation.
Its committed Session Records remain, and retrying creates a new Agent Turn.
_Avoid_: resumable turn, partial Session

**Model Step**:
One model invocation within an Agent Turn. _Avoid_: Agent Turn, iteration

**Tool Call**:
One request by an Agent to invoke a tool, together with its resulting completion,
rejection, or failure. _Avoid_: command, action

**Agent Identifier**:
The stable identity of one Agent, used to select and correlate that Agent across configuration, permissions, and Agent Turns. It is distinct from an Agent Turn and from a display label.
_Avoid_: display name

**Agent Turn Identifier**:
The identity of one Agent Turn, used to correlate its live execution and emitted events. Retrying creates a new Agent Turn Identifier.
_Avoid_: Session Identifier

**Tool Call Identifier**:
The identity of one Tool Call within an Agent Turn, used to connect its request, outcome, approval, event, and durable result. It is distinct from the tool name.
_Avoid_: tool name

**Model Step Identifier**:
The identity of one Model Step within an Agent Turn. It distinguishes separate model invocations in the same turn.
_Avoid_: Agent Turn Identifier

**Model Identifier**:
The identity of a Model Catalog entry. A model selection pairs it with a Connection Provider identity.
_Avoid_: model capability

**Session Identifier**:
The identity of one durable conversation Session, whether primary, delegated, interactive, or one-shot. It identifies that Session's history and single-writer authority, not a particular live runtime instance. _Avoid_: Agent Turn Identifier, Delegated Task ID

**Session Message Identifier**:
The identity of one user or assistant message tracked by a session and referenced by session operations such as compaction.
_Avoid_: Tool Call Identifier

**Submission Identifier**:
The stable identity assigned when a Session admits one Submission. It follows that Submission through queue admission, durable steering, model processing, and deliberate retry, and is distinct from the Session Message Identifier and transport request identifier. _Avoid_: RPC request identifier, queued-only identifier, lane-local identifier

**Session Record Identifier**:
The identity of one committed durable Session Record. It is distinct from the Session, its messages, and the Agent Turn that produced it.
_Avoid_: Session Identifier

**Steering Status**:
The committed processing lifecycle of a Steering Message. Acceptance and notifications of delivery, processing, or failure follow the corresponding successful store commit; failed input keeps its identity and blocks later messages until deliberate retry. _Avoid_: queue admission, transient turn status

**Attachment Identifier**:
The identity of externally stored content referenced by a Session. It identifies the attachment content, not its filename or workspace path.
_Avoid_: filename, blob key

**Compaction Identifier**:
The identity of one compaction summary associated with a Session. It links the summary to its predecessor and covered messages.
_Avoid_: summary text

**Workspace Identifier**:
The identity of a workspace scope that owns Sessions and their attachments.
_Avoid_: workspace path

**MCP Snapshot Identifier**:
The identity of one transient MCP tool catalog snapshot. It determines whether a tool execution still uses a current catalog.
_Avoid_: MCP server name


**Agent Turn Event**:
A transient fact from a running Agent Turn, such as tool progress, which may be observed before its corresponding Session Record is committed. It is not itself a durable record or proof that an operation can be replayed after restart. _Avoid_: persisted event, Session Record

**Session Record**:
The durable representation of committed Session content and lifecycle
outcomes. Token deltas and other incomplete Agent Turn Events are not Session
Records. _Avoid_: stream chunk, event log

**Attachment Reference**:
A durable Session content part that identifies externally stored content by its Attachment Identifier and metadata, without carrying attachment bytes.
_Avoid_: File Mention, expanded attachment, file-content message

**File Mention**:
A workspace-scoped reference to a file or directory whose bounded content is retained with the Session and can be expanded into model context.
_Avoid_: Attachment Reference, arbitrary filesystem path

**Operational Failure**:
An expected failure during an Agent Turn, represented with a stable code, source,
and retry disposition. It is distinct from an invariant violation in Wincode
code. _Avoid_: exception, provider error

**Built-in Agent**:
An Agent owned and shipped by Wincode. Built-in Agents have reserved names and
cannot be replaced by user configuration. _Avoid_: Default Agent, system agent

**Configured Agent**:
An Agent defined by a user through Wincode configuration. _Avoid_: Custom Agent,
user agent

**Agent Role**:
An Agent's eligibility: `primary`, `subagent`, or `all`. The `all` role means the
Agent is eligible for both primary and delegated work; it does not grant full
tool permissions. _Avoid_: Agent mode, access level, full permission

**Primary Agent**:
An Agent eligible to lead the active session and be selected by the user.
Agents with the `primary` or `all` role are Primary Agents. _Avoid_: Main Agent

**Subagent**:
An Agent eligible to execute work delegated by another Agent. Agents with the
`subagent` or `all` role are Subagents. _Avoid_: Child agent, secondary agent

**Tool Permission**:
The effective decision governing whether an Agent may invoke a tool for a
resource: `allow`, `ask`, or `deny`. Tool Permission is independent of Agent
Role. _Avoid_: Agent Role, tool availability

**Permission Rule**:
An ordered policy entry that matches a tool action and optionally a resource
pattern to produce a Tool Permission. When multiple rules match, the later rule
wins. _Avoid_: ACL entry, tool toggle

**Tool Gate**:
The runtime enforcement of Tool Permission for one tool call. The gate
evaluates the effective decision against the call's actual resource, applies
temporary grants and auto approval, and registers a surviving `ask` as an
Approval Request the Agent Session settles through the panel the session
projects. It owns the manual-approval safety ceiling at execution time: a
remembered grant is never recorded for a safety ask. Coding tools, shell
(per-node evaluation with a doom_loop repeat guard, ADR-0008), MCP tools, and
Skill Activation all resolve through the one gate, and the gate owns the
deny/reject wording each family emits. _Avoid_:
approval service, permission middleware

**Coding Tool Catalog**:
The set of coding tools the application knows how to describe and execute.
Catalog membership does not make a tool visible to an Agent or grant Tool
Permission; those are separate decisions. _Avoid_: Runtime Tool Registry,
permission allowlist

**Runtime Tool Registry**:
The definition-only collection of Tool Definitions recognized by the Agent
Runtime; it carries no executor or Tool Permission decision. The Coding-Agent
Application composes selected catalog tools as Resolved Tools through the Tool
Gate for each Agent Turn. _Avoid_: Coding Tool Catalog, executable registry

**Resolved Tool**:
A tool definition whose executable path has been composed through the Tool Gate
for an Agent Turn. Resolution makes a tool available; Tool Permission is still
evaluated against each actual Tool Call. _Avoid_: approved tool, raw executor

## Tool Resource Profile

A named execution budget for local coding tools. The standard profile is the
normal bounded posture; elevated profiles permit larger bounded inspection,
search, execution, and preview results and require a Tool Gate approval.

## Prompt Composition

**Prompt Composition**:
The domain process that composes provider-neutral System Prompt content for one Agent Turn from resolved Agent guidance, Project Instructions, environment, and effective Tool Permission. It is not the System Prompt artifact or the metadata describing its composition.
_Avoid_: Prompt Assembly, prompt text, system message

**System Prompt**:
The provider-neutral instruction content supplied to the model in the system role for one Agent Turn. It excludes turn-scoped Skill context, tool schemas or executors, and Prompt Composition metadata or diagnostics.
_Avoid_: Prompt Composition, Skill context, system message

**Prompt Composition Pipeline**:
The orchestration boundary that prepares resolved context and coordinates Prompt Composition for an Agent Turn. It is not the System Prompt artifact or an individual block renderer.
_Avoid_: System Prompt, prompt renderer, Agent Turn

**Compaction Prompt**:
The instruction content used to summarize completed Session Records for a later Agent Turn. It is separate from the System Prompt and does not become part of the coding Agent's turn-scoped instructions.
_Avoid_: System Prompt, session instructions

**Compaction Summary**:
A concise handoff of the user's goal, constraints, completed/current/blocked work, decisions, next steps, critical context, and relevant files, derived from the messages selected for compaction. It helps a later Agent Turn continue the work; message coverage and compaction boundaries are separate metadata.
_Avoid_: summary text, compacted transcript
