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
or authentication behavior.

## Language

**Built-in Command**:
A fixed UI action the CLI ships with, dispatched by kind to an adapter
(`/new`, `/models`, `/exit`). _Avoid_: Command, slash command

**Custom Command**:
A user-defined prompt template loaded from a command folder, inserted into the
conversation as a user message when executed. _Avoid_: Command, slash command

**Agent**:
A named AI behavior that can lead a conversation, execute a delegated task, or
both. Its role and tool permissions are separate concerns. _Avoid_: Coding Mode,
persona

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
An Agent eligible to lead the active conversation and be selected by the user.
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
