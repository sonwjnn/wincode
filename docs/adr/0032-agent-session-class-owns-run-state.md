# Agent Session class owns session run state

Status: accepted

ADR-0031 establishes the Agent Session as the sole owner of live session state.
The class now holds the authoritative Session Context, transcript, input lanes,
run state, and command ordering for one session. Keeping this ownership in one
place prevents admission, busy state, interruption, and continuation from
disagreeing. It does not require every workflow to live in the class: the
current constructor still coordinates submission, approval, maintenance, and
queue-draining behavior that should be separated into focused internal modules.

The class owns the active send's abort controller, deadline, settlement, and
explicit run phase; consumer-visible status such as `turnActive` is derived from
authoritative state. Preserve distinct phases where behavior differs, including
an admitted Submission awaiting attachment externalization, an executing Agent
Turn, a settling checkpoint, and maintenance in flight. Extract input-lane,
turn/submission, maintenance, and approval workflows behind narrow internal
capabilities. These collaborators may hold temporary per-command data and
perform effects, but must request session state transitions through the Agent
Session; none becomes another long-lived owner of admission, queues, or busy
state. The Agent Session remains the point that applies transitions and emits
consistent immutable Session Snapshots and ordered events.

Keep the caller-facing Agent Session interface centered on commands, snapshots,
and events. State-writing operations needed by the Session Host or Agent Runtime
belong behind internal ports, not on that caller-facing interface. This is a
follow-up boundary refinement: the present interface still exposes several such
operations. The Session Host retains assembly, lease, and lifetime; Agent
Runtime retains Model Step and Tool Call state for one Agent Turn. The class
uses composition and requires no base class.

Name the Session Host's turn-execution capability `SessionTurnRunner` and its
Agent Session port `turnRunner`, replacing `SessionRuntimePort` and `runtime` in
the session layer. This capability prepares a coding-agent turn, invokes the
core runtime, and forwards events and checkpoints; it is not a second Agent
Runtime. Keep `AgentRuntime` and its model/tool loop in `@wincode/agent-core`.
The rename changes no execution or state ownership.

This refines ADR-0019's former factory and stateful `SessionOperation` choice;
its one-owner, one-command-lane decision remains in force. The earlier rejection
of Factory Method and Abstract Factory patterns also remains: this class
introduces neither a product family nor an inheritance-based factory. Preserve
the existing `prompt()`, `steer()`, `continue()`, `send()`, interrupt, queue,
recovery, approval, and shutdown contracts while separating workflow
implementation from state ownership.
