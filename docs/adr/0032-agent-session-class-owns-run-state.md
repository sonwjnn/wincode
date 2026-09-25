# Agent Session class owns session run state

Status: accepted

ADR-0031 establishes the Agent Session as the sole owner of live session state,
but the current factory and its stateful `SessionOperation` helper maintain
related activity facts in separate places. An Agent Session is a long-lived
object with one identity, command lane, and shutdown boundary. Implement it as
a class whose private state is the authority for admission, the active run,
queue draining, compaction, overflow recovery, and approval settlement. Its
public interface and immutable Session Snapshot remain the way callers and
observers interact with that state.

The class owns the active send's abort controller, deadline, and settlement;
consumer-visible status such as `turnActive` is projected from authoritative
run state. Preserve distinct phases where they affect behavior, including an
admitted Submission awaiting attachment externalization, an executing Agent
Turn, a settling checkpoint, and a compaction in flight. Submission helpers may
remain in separate modules, but they must change session state through the
Agent Session rather than maintain another admission or busy authority. The
Session Host still owns assembly, lease, and lifetime; Agent Runtime still owns
Model Step and Tool Call state for one Agent Turn. The class uses composition
and requires no base class.

This refines ADR-0019's implementation choice to keep `SessionOperation` as a
stateful single-send primitive and to construct the owner with a factory
function. Its one-owner, one-command-lane decision remains in force. The
earlier rejection of Factory Method and Abstract Factory patterns also remains:
using a class for one session instance introduces neither a product family nor
an inheritance-based factory. Preserve the existing `prompt()`, `steer()`,
`continue()`, `send()`, interrupt, queue, recovery, approval, and shutdown
contracts while moving run state into the owner.
