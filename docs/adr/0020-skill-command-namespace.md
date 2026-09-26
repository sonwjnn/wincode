# Skill Invocation Lives in a Reserved Command Namespace

Skill names are validated as lowercase hyphenated words, so `review` is both a
plausible Skill and a plausible Custom Command name, and it collided with
Built-in Command names on the typed path too: the submit resolver checked
`isSettingsCommand`/`parseCompactCommand` and then resolved `/name` against the
discovered Skill catalog, so a Skill named `models` won over the Built-in
Command of that name. The `/skills` picker also listed Skills separately from
the `/` command list, with its own filter algorithm and its own insertion text.

Skills now live in a reserved namespace inside the chat input grammar.

Status: accepted

## Decision

`skill:` is the namespace a Skill invocation must carry: a row renders as
`skill:review` (no leading slash — the overlay context supplies it), selecting a
row writes `/skill:review ` into the input, and the typed form is
`/skill:review arguments`. A bare `/name` never resolves a Skill, so a Custom
Command and a Skill may share a name and stay reachable: `/review` is the Custom
Command, `/skill:review` is the Skill.

The namespace is input-layer only. The Skill catalog, the model-facing `skill`
tool, and durable activation records keep the raw Skill name.

Text that claims the namespace but names no discovered Skill — or that is
malformed — is reported as an input error and never reaches the transport as
ordinary prompt text. Enter inside the open command list belongs to that list,
so the report is reachable once the line leaves it (a space or an argument).
A Custom Command may not claim the namespace: the loader rejects a filename that
starts with `skill:` the same way it rejects a Built-in Command collision.

One `CommandItem` list merges Built-in Commands, Custom Commands, and Skills
(sorted Built-in Commands, Custom Commands, Skills). Built-in and Custom
Commands match by label prefix. Skill rows match by label prefix and fuzzy
subsequence against the bare Skill name, whether or not the query includes the
`skill:` namespace. This keeps `/skill:sdk` able to find `skill:ai-sdk`. The
`/skills` picker and its `kind: "skills"` adapter are removed: the command list
is the one surface that lists and inserts Skills.

Typed Built-in Commands dispatch through the same command executor the overlay
uses, ahead of the view's busy guard, so `/models` and `/compact focus` behave
identically whether selected or typed. Extra text after a Built-in Command that
takes no arguments leaves the line ordinary prompt text.

This revises the explicit-invocation syntax recorded in ADR-0004; its activation
semantics (turn-scoped snapshot, permission gate, slot budget) are unchanged.
