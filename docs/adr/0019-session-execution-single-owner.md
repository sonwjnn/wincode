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
applies Session Commands one at a time in submission order, keeps turn-scoped
values inside the execution that produced them, and publishes immutable Session
Snapshots. The hook becomes a binding that constructs the Engine from injected
ports and reads Snapshots; it never writes session state.

Status: accepted

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
