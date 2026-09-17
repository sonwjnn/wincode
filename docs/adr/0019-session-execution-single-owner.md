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
discarded with it. Compaction has shipped as the first Session Command: the
Engine runs it against the Session Compaction module as its port, publishes the
Session Context swap and the Compaction entry inside the command, and joins a
caller to a compaction that carries the same intent, while the module's
per-session in-flight map — the only admission decision — refuses another
intent's. The approval lifecycle has shipped as the Engine's own: an approval
request is registered with the Engine, settles exactly once as allow, reject,
or abort — whichever route triggers it — and the panel registry is a read-only
projection of the Engine's pending requests, so the binding's second,
independent settlement route and its one-shot abort latch are gone. Context
overflow recovery has shipped as a Session Command too: the first
context-overflow refusal of an Agent Turn records the user message the turn
answers, compacts the replay-safe history through the Engine's own compaction
command, and replays that message; the record belongs to the command, so the
replayed turn cannot chain into another recovery and no send can reset it, and
a replay the send lane refuses is reported rather than queued behind, or
overlapped with, a send the user started. The submission pipeline has shipped
too, closing the migration (spec issue #97, steps #98–#102): a send is a
Session Command that prepares the submission, commits the accepted prompt, runs
the Agent Turn with its terminal commit, and maintains the compaction threshold
afterwards — all against ports the Engine defines — so retry, cancellation,
interruption, and approval settlement are commands on the same lane. The hook
is a binding that constructs one Engine per mounted session from the TUI-side
ports and reads Session Snapshots, and it holds no session state; the
Session Controller is deleted, with the Agent Runtime consumer and the Session
View State living with the Agent Turn they consume; and the Snapshot publishes
facts (`turnActive`, `isCompacting`, pending Approval Requests) with a derived
`isSessionBusy` selector instead of a chat-status union. The Engine still
exposes its granular state setters alongside the commands, and the port surface
is the TUI's rather than a second host's, so a non-TUI host reuses the Engine
without a workspace extraction but has not been built.

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
  cannot change session state; the Session Controller's duplicate listener
  plumbing was deleted with the controller when the submission pipeline moved
  into the Engine (#102), rather than factored into a shared abstraction whose
  second user was one ticket away from removal.
- The Engine's React-free claim is checked, not asserted: a boundary test walks
  the Engine's module graph transitively and fails if React or a terminal
  renderer becomes reachable, so a barrel cannot smuggle one back in.
