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

## Language

**Wincode CLI**:
The user-facing command-line entry point that selects and dispatches a CLI
Command. It does not refer to the interactive terminal application.
_Avoid_: TUI, interactive application

**Wincode TUI**:
The interactive terminal application through which users conduct Wincode
sessions. It is launched by a CLI Command.
_Avoid_: CLI, command dispatcher

**CLI Command**:
A user-invoked operation dispatched by the Wincode CLI. A CLI Command may launch
the Wincode TUI or complete without an interactive interface.
_Avoid_: Command, Built-in Command, slash command

**Line Range**:
A 1-indexed, inclusive selection of consecutive lines in a text file. Multiple
Line Ranges in one read form a single ordered selection; overlapping or
adjacent ranges collapse into one. _Avoid_: line slice, offset window

**Line Range Selector**:
The optional part of a Read Tool target that names one or more Line Ranges.
When a complete target also names an existing literal file, the literal file
takes precedence over interpreting its suffix as a Line Range Selector.
_Avoid_: pagination, read offset

**Built-in Command**:
A fixed UI action the CLI ships with, dispatched by kind to an adapter
(`/new`, `/models`, `/exit`). _Avoid_: Command, slash command

**Custom Command**:
A user-defined prompt template loaded from a command folder, inserted into the
session as a user message when executed. _Avoid_: Command, slash command

**Skill**:
A named set of instructions that augments an Agent for one user turn. A Skill may
be selected explicitly by the user or activated by the Agent. _Avoid_: Agent,
session mode, Custom Command

**Skill Activation**:
The selection of a Skill for the current user turn. Activation does not persist
to later turns. _Avoid_: Skill installation, session Skill

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
temporary grants and auto approval, and routes a surviving `ask` through the
session approval queue and inline panel. It owns the manual-approval
safety ceiling at execution time: a remembered grant is never recorded for a
safety ask. Coding tools, shell (per-node evaluation with a doom_loop repeat
guard, ADR-0008), MCP tools, and Skill Activation all resolve through the one
gate, and the gate owns the deny/reject wording each family emits. _Avoid_:
approval service, permission middleware

**Resolved Tool**:
A tool definition whose executable path has been composed through the Tool Gate
for an Agent Turn. Resolution makes a tool available; Tool Permission is still
evaluated against each actual Tool Call. _Avoid_: approved tool, raw executor

## Tool Resource Profile

A named execution budget for local coding tools. The standard profile is the
normal bounded posture; elevated profiles permit larger bounded inspection,
search, execution, and preview results and require a Tool Gate approval.
