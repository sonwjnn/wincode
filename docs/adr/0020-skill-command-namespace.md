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

Revision: typed command dispatch is gone. Built-in Commands, Custom Commands,
and Skills run only when the composer selects their overlay row; typed or
pasted text — including `/skill:review` and `/compact focus` — stays ordinary
prompt text. A selected Skill row still writes `/skill:<name>` as a tracked
selection, and the reserved namespace, the aggregate row, and the bare-name
reachability rule are unchanged. The namespace-mismatch input error went away
with the typed parser. Skill search now matches names only.

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

The root command list always shows Built-in Commands, Custom Commands, and one aggregate
`skill:` row when Skills are discoverable. The row's count reflects the current chat's catalog;
selecting it enters `/skill:` search. Skill results fuzzy-match names and descriptions in that
search and in nonempty bare slash queries. `/skill` shows the namespace chooser rather than
individual Skills. `/skills` is not a Built-in Command, but may fuzzy-match Skills like any
other bare slash query.

The dedicated `/skills` browser and its Built-in Command were removed. More generally, an open
command list with no matching row submits the typed line instead of swallowing it.

Typed Built-in Commands dispatch through the same command executor the overlay
uses, ahead of the view's busy guard, so `/models` and `/compact focus` behave
identically whether selected or typed. Extra text after a Built-in Command that
takes no arguments leaves the line ordinary prompt text.

This revises the explicit-invocation syntax recorded in ADR-0004; its activation
semantics (turn-scoped snapshot, permission gate, slot budget) are unchanged.
