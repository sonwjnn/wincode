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
variants. It references a Connection Provider by ID but does not own credentials
or authentication behavior. An entry that remains in the catalog but is no
longer selectable is retired rather than deleted, so existing Session Records
keep their model identity. A deliberate clean-cutover prune MAY delete legacy
IDs after the corresponding persisted data is reset; the 2026-09 prune used
that exception.
_Avoid_: pricing table, provider model list, discovery

**Model Lifecycle**:
Whether a Model Catalog entry may be selected for a new turn: `active` or
`retired`. Retirement is a product decision, independent of whether the
provider still serves the model. _Avoid_: deprecation, availability

**Thinking Level**:
A named reasoning effort a model supports, or the absence of one. It is a
property of a Model Catalog entry's thinking policy, and the level identifier
is what a session persists. _Avoid_: effort, thinking mode, variant

**Variant ID**:
The stored and wire name of a Thinking Level — `modelVariantIds` in
`@wincode/ai`, the `variant` column on `session`, and the `variant` key in
message metadata. The identifier is stable; only the identifier is persisted,
never the expanded provider request. _Avoid_: treating the ID as the model's
capability

**Model Descriptor**:
A Model Catalog entry together with where its metadata came from and whether
that metadata is current. This is the shape a reader resolves; the entry itself
stays immutable. _Avoid_: model record, merged model

## Model Target

A Model Target is the effective Connection Provider, model, Thinking Level, and
minimal authorization selected for one Agent Turn. It is transient and must not
become a Session Record. _Avoid_: AI SDK model, persisted model handle

## Session Selection

The last-used Agent, Model, and variant recorded in a session's message
metadata, resolved when a session opens or a turn is sent. Two tiers are
recorded on write and merged on read: the session row holds the
session-level choice (the user's prompt-config selection), and message
metadata holds the effective selection (what a turn actually ran with,
including Agent pins). Restore reads leniently (a selection survives partially
broken metadata); the request body reads it strictly (only schema-valid pairs
reach the send). Sources merge in a fixed order — session row, then message
metadata, then prompt-config refs. _Avoid_: chat config, latest config

## Session Execution

**Session Engine**:
The single owner of one session's live state and the only writer to it. Session state changes only through the Engine, and observers read a Session Snapshot. _Avoid_: session manager, session store, session state holder

**Session Host**:
The composition that assembles one session — its capabilities, its Session Engine, and its subscription to that Engine — and owns that assembly's lifetime. It carries no session state of its own and is UI-neutral, so Interactive Mode and non-interactive modes each construct one against the same contract. _Avoid_: bootstrap, session manager, runtime, composition root

**Session Lease**:
The exclusive live claim a Session Host holds while its session is open, so only that Host's Session Engine may write the session. The claim ends with the Host and can be recovered after its owner disappears; losing it ends the Host rather than allowing two live writers.
_Avoid_: session lock, presence, session status

**Session Command**:
A request to change session state, such as sending a prompt, interrupting a turn, compacting, recovering from a context overflow, or answering an approval. The Engine executes Commands one at a time in submission order, and no asynchronous continuation changes session state outside a Command. _Avoid_: operation, action, event, task

**Compaction Intent**:
What one compaction request asks for: its trigger and its focus, as distinct from the messages it runs over and the Model Target selection its summary is generated with. The Session Compaction module admits a request that carries the intent already in flight and refuses one that carries another, so no caller is answered with another caller's entry while two threshold passes, which share an intent, still meet in one operation. _Avoid_: compaction request, compaction options

**Overflow Recovery**:
The one recovery a context-overflow refusal buys for the Agent Turn it ended: the Engine compacts the replay-safe history — the Session Transcript up to that turn's original user message, with the interrupted turn that followed it sanitized away — and replays that message. The attempt is recorded against the message the turn answers, so the replayed turn cannot chain into another recovery and no send can reset it. _Avoid_: retry, resend

**Approval Request**:
One Tool Permission `ask` a waiting Tool Gate evaluation is registered for. The Session Engine owns it from registration to settlement: it is pending until exactly one settlement — allow, reject, or abort — whichever route triggers it, so no route can leave the evaluation waiting or settle the request twice. The session projects its pending Approval Requests into the panel surface, and closing them, aborting them, or shutting the session down runs through the same path. _Avoid_: approval prompt, approval handle, approval queue

**Session Snapshot**:
The session facts an observer reads at one moment. Observers read Snapshots only, so none of them sees a partially applied Session Command. _Avoid_: full state, state dump

**Session Transcript**:
The ordered messages a session presents to the user. Compaction summaries stay out of the Transcript even when they are part of the Session Context. _Avoid_: chat history, display messages, message log

**Session Context**:
The messages a session sends to the model for its next Agent Turn. It is derived from the Session Transcript through compaction and interruption sanitation, so the two can differ. _Avoid_: active messages, prompt history, context window

**Agent Turn Execution**:
One run of an Agent Turn and everything scoped to it: the Agent Turn Identifier, the assistant message identity, the source user message, the start time, the Agent and resolved Agent, the Model Target selection and variant, the session-level selection its records carry, the MCP snapshot, the child abort registry, and its own Session View State. The Engine's record of an execution carries the identity every observer reads, while the host scope carries what only the host owns — the resolved Agent, the armed Skill catalog, the MCP snapshot, the child abort registry, and delegation bookkeeping. A delegated Subagent execution uses the same contract plus its parent linkage (`parentTurnId`, `parentToolCallId`), and is created and discarded with the turn rather than rebuilt on render. _Avoid_: turn context, session refs, current turn

**Session View State**:
The live, transient projection of one Agent Turn Execution for the session UI. It never becomes a Session Record, and executions never share one: the Session Snapshot exposes the Session View State of the most recently active execution, so a delegated Subagent's stream replaces the view while it runs and the parent's view returns when it ends. _Avoid_: streaming state, live buffer

**Submission**:
The user-authored content one send accepts: text, attachments, pasted text, and an optional Skill or Custom Command invocation. _Avoid_: message, request

**Queued Submission**:
A Submission a busy session accepts and holds instead of running immediately. It is transient Session Engine state — not a Session Record, never replayed after a restart — and it enters the Session Transcript only when it starts running. _Avoid_: queued prompt, pending message, backlog item, steering (that is a Steering Message), interjection

**Submission Queue**:
The FIFO order of a session's Queued Submissions, exposed in the Session Snapshot. The Session Engine drains it after each terminal Agent Turn outcome; a user interrupt recalls it to the composer instead of draining it. _Avoid_: message queue, follow-up list, outbox

**Recall**:
Withdrawing a session's waiting user messages back into the composer in order, restoring their composition instead of running them. It withdraws the Steering Lane and the Submission Queue together. _Avoid_: dequeue, withdraw, unsend, retract, delete

**Steering Message**:
A user-authored message a session accepts while an Agent Turn is running and delivers to the model inside that same turn, between Model Steps. It carries text only: it cannot carry attachments, invoke a Skill or Custom Command, or change the Agent. It becomes a Session Record and enters the Session Transcript when it is delivered. _Avoid_: mid-turn message, interjection, follow-up, steering prompt

**Steering Lane**:
The FIFO order of a session's Steering Messages. Its messages are delivered at Model Step boundaries inside the running Agent Turn, so they never wait for that Agent Turn to end. _Avoid_: steering queue, interjection lane, mid-turn queue

## Language

**Wincode CLI**:
The user-facing command-line entry point for the Coding-Agent Application. A bare invocation selects Interactive Mode; `--mode` or `-m` selects another Execution Mode by its full name, and `--prompt` or `-p` supplies one-shot input. It does not own Agent or Session state. _Avoid_: Wincode TUI, command dispatcher

**Coding-Agent Application**:
The user-facing Wincode application that runs an Agent through one of four Execution Modes: Interactive, Print, JSON, or RPC. It owns application lifetime and the input/output boundary while the Session Engine owns live session state. _Avoid_: Wincode TUI, CLI package, agent core

**Execution Mode**:
A user-facing way to run the Coding-Agent Application. Each mode chooses input, output, and process lifecycle but does not own Session state. _Avoid_: Coding Mode, agent loop

**Interactive Mode**:
The terminal interface through which users conduct Wincode sessions. It is the default mode of a bare `wincode` invocation. _Avoid_: Wincode TUI, TUI application, CLI

**Print Mode**:
A one-shot mode that opens or creates one One-Shot Session, accepts exactly one Submission from `--prompt`, `-p`, or stdin, and streams only human-readable assistant text to stdout before exiting. _Avoid_: text mode, batch mode

**JSON Mode**:
A one-shot mode that opens or creates one One-Shot Session, accepts exactly one Submission from `--prompt`, `-p`, or stdin, and emits one JSONL record per structured Agent Turn event, not JSON-RPC request/response frames. _Avoid_: JSON-RPC mode, RPC

**One-Shot Session**:
The durable Session opened or created for one Print Mode or JSON Mode invocation. It accepts exactly one Submission for that invocation and remains persisted after the mode exits; its Session Host ends after the terminal Agent Turn outcome. _Avoid_: ephemeral session, batch session

**Invocation Selection**:
The Agent, Model, and Thinking Level resolved for one Print Mode or JSON Mode invocation. Explicit CLI selectors override a Session Selection; omitted selectors restore it or use configuration, and creating a One-Shot Session requires complete resolution before its first record. _Avoid_: command-line config, request selection

**JSON Event Stream**:
The ordered public Agent Turn events emitted by JSON Mode as JSONL. It uses the same event vocabulary and projection as RPC Mode but does not include JSON-RPC envelopes, request IDs, commands, or state notifications. _Avoid_: raw Session Snapshot, JSON-RPC stream

**Non-Interactive Approval**:
A Tool Permission `ask` encountered by Print Mode or JSON Mode. Without explicit auto-approval it fails closed rather than waiting; `--auto` may allow ordinary asks, while safety asks and explicit denies remain blocked. _Avoid_: unattended approval, automatic permission

**RPC Mode**:
A long-lived mode that communicates over JSON-RPC 2.0 framed as JSONL. The client initializes the process and then creates or opens exactly one Session Host; the protocol remains independent of CLI mode selection. _Avoid_: JSON mode, session server

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
A fixed UI action the CLI ships with, dispatched by kind to an adapter
(`/new`, `/models`, `/exit`). _Avoid_: Command, slash command

**Custom Command**:
A user-defined prompt template loaded from a command folder, inserted into the
session as a user message when executed. _Avoid_: Command, slash command

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
The identity of one durable interactive session that contains Session Records and their messages.
_Avoid_: Agent Turn Identifier

**Session Message Identifier**:
The identity of one user or assistant message tracked by a session and referenced by session operations such as compaction.
_Avoid_: Tool Call Identifier

**Submission Identifier**:
The stable identity assigned when the Session Engine admits one Submission. It follows that Submission whether it starts immediately, waits in either lane, or changes disposition, and is distinct from both a lane-local waiting-message identifier and a transport request identifier.
_Avoid_: RPC request identifier, Queued Submission Identifier, Steering Message Identifier

**Session Record Identifier**:
The identity of one committed durable Session Record. It is distinct from the Session, its messages, and the Agent Turn that produced it.
_Avoid_: Session Identifier

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
A transient fact emitted while an Agent Turn is running for live observation and
control. It is not a durable Session record. _Avoid_: persisted event,
message

**Session Record**:
The durable representation of committed Session content and lifecycle
outcomes. Token deltas and other incomplete Agent Turn Events are not Session
Records. _Avoid_: stream chunk, event log

**Attachment Reference**:
A durable Session content part that identifies externally stored or
workspace-backed content without embedding its transient model expansion.
_Avoid_: expanded attachment, file-content message

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
Approval Request the Session Engine settles through the panel the session
projects. It owns the manual-approval safety ceiling at execution time: a
remembered grant is never recorded for a safety ask. Coding tools, shell
(per-node evaluation with a doom_loop repeat guard, ADR-0008), MCP tools, and
Skill Activation all resolve through the one gate, and the gate owns the
deny/reject wording each family emits. _Avoid_:
approval service, permission middleware

**Runtime Tool Registry**:
The definition-only collection of Tool Definitions recognized by the Agent
Runtime; it carries no executor or Tool Permission decision. The Coding-Agent
Application composes selected catalog tools as Resolved Tools through the Tool
Gate for each Agent Turn. _Avoid_: executable registry

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
