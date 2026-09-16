# Session Execution Has One Owner and One Command Lane

Session execution state was spread across four independent notions of "a turn
is running": the `useChat` hook's `SessionChatStatus` plus its ref/state
mirrors, `SessionControllerState`, the Session View's busy flags, and the
approval queue. Three overlapping single-flight mechanisms guarded the same
work (the hook's `compactionOperationRef`, `SessionCompactionModule`'s
per-session in-flight map, and `SessionOperation`'s active-send record), and
turn-scoped values (assistant message identity, source user message, model
selection, MCP snapshot, child abort registry) lived at session scope, so any
asynchronous continuation read them through a ref written during render.

Session state now has exactly one owner: a React-free Session Engine that
publishes immutable Session Snapshots and is the only writer of a session's
live state. The hook binds that Engine and never writes session state.

Status: accepted

The state-ownership half of this decision has shipped, and so has execution
scoping: the Engine tracks the live Agent Turn executions of a session with
their parent linkage, exposes the Session View State of the most recently
active execution, and a finishing execution drops only its own view, while the
turn-scoped values themselves (Agent Turn Identifier, assistant message
identity, source user message, start time, Agent and resolved Agent, Model
Target selection and variant, session-level selection, MCP snapshot, child
abort registry, and Skill catalog) are created with the execution and
discarded with it. The rest — Session Commands executed one at a time in
submission order, orthogonal status facts, a single approval settlement path,
and the submission pipeline living in the Engine — is the design the migration
is closing on, tracked by the Session Engine spec (issue #97) and its five step
tickets (#98–#102), and is not yet the shipped execution model: the Engine
still exposes granular state setters, executions are started by the binding
rather than by a Session Command, chat status is still one union, and approvals
still settle through two paths. Read the consequences below as the target, not
as a description of every line of running code.

## Considered options

- **Targeted guards inside the existing hook** — cheapest, but keeps the
  ref/state mirrors, the duplicate status notions, and the three single-flight
  mechanisms; every new interleaving needs another latch and the class of
  defect survives.
- **Keep `SessionController` as the execution seam and add a state owner above
  it** — creates two status sources and two places that decide whether a send
  is accepted.
- **Split the hook into several smaller hooks with no single owner** — reduces
  file length, not writer count. The races come from multiple writers to the
  same state, not from one long file.
- **One Engine, one command lane, per-execution scope (accepted)** — the Engine
  owns Session Transcript and Session Context, turn status facts, compaction
  state, the approval lifecycle, and turn orchestration. `SessionOperation`
  survives only as the internal single-send primitive carrying the deadline and
  interrupt semantics, and controller-level status/subscription stops being
  visible to the UI.
- **GoF Factory Method or Abstract Factory** — rejected: the pattern needs a
  product family and a variation point that decides which product is created,
  and no such variation exists. The Engine is created by a factory function,
  matching the existing `createSessionCompaction` / `createToolGate` idiom.

## Consequences

- Session state changes only inside a Session Command. Context-overflow replay,
  approval settlement, and compaction publication become Commands instead of
  detached asynchronous continuations.
- Session status becomes orthogonal facts (`turnActive`, `compacting`,
  `pendingApprovals`) with a derived busy selector, replacing four parallel
  notions of "running".
- Turn-scoped values move into an execution scope, so a delegated Subagent
  execution no longer overwrites the primary execution's Session View State.
- The Engine depends only on injected ports (model target resolution, MCP
  snapshots, Tool Gate, approval decisions, store, skills, prompt composition)
  and never imports React or TUI rendering. A future non-TUI host reuses the
  Engine without first extracting a workspace package; queued sends remain
  deferred by issue-86 and become a lane policy rather than a structural
  change.
- Approval requests have exactly one settlement path. The panel registry is a
  read-only projection, and closing approvals is a Session Command rather than
  a second, independent settlement path.
- The Engine owns its own emitter, including the policy that a failing observer
  cannot change session state. While `SessionController` still exists its
  listener plumbing duplicates that shape; the copy is deleted with the
  controller by the ticket that moves the submission pipeline into the Engine
  (#102) rather than factored into a shared abstraction whose second user is one
  ticket away from removal.
- The Engine's React-free claim is checked, not asserted: a boundary test walks
  the Engine's module graph transitively and fails if React or a terminal
  renderer becomes reachable, so a barrel cannot smuggle one back in.
