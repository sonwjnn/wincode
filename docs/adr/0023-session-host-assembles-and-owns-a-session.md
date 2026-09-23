# A Session Host assembles a session and owns its lifetime

The Session Engine is React-free, but the only thing that has ever constructed
one is a React hook: `useSessionEngine` read capabilities from React context and
refs, built the Engine, subscribed to its Snapshot, and left teardown to a React
effect. ADR-0019 anticipated a non-TUI host reusing the Engine and left the port
surface "the TUI's rather than a second host's". This decision builds that host:
it assembles one session's capabilities, Engine, and Snapshot subscription, and
it opens the session — the transcript, context, and compactions the Engine is
born with — before the Engine exists.

Status: accepted
Package placement note: ADR-0027 revises the temporary `@wincode/tui` location and the deferral of a coding-agent application package. The Session Host's UI-neutral contract, opening, lease, subscription, and shutdown decisions remain accepted.

## Decision

- **The Session Host is the composition root for one session.** Its factory is
  asynchronous and returns a handle exposing the Engine, the current Session
  Snapshot, subscription to that Snapshot, the Agent Turn Events the Engine
  already receives, and `shutdown`. The consumer that constructs a Host owns
  calling `shutdown`, so teardown has one place rather than one per consumer.
- **Opening a session is construction, not a Session Command.** The Host loads
  the Session Transcript, Session Context, and compactions and passes them to
  `createSessionEngine({ initialTranscript, initialContext, initialCompactions })`.
  The Engine stays synchronous, and no Command has to model a session that
  exists exactly once. Presentation-only facts, such as a session's title, stay
  with the surface.
- **The Host's dependency contract is UI-neutral.** No React-shaped value — a
  `MutableRefObject`, a context value type — crosses it, and React-free logic
  that currently lives inside React-importing modules moves to neutral modules.
  Capabilities are supplied as lazy getters, because a session outlives the
  render that supplied them.
- **The Host re-exposes Agent Turn Events alongside the Snapshot.** No new event
  vocabulary and no wire protocol: serialization belongs to whoever builds the
  consumer.
- **The Host's module graph is checked, not asserted.** The React-free boundary
  test walks from the Host entry, not only from `session-engine.ts`, so a
  React-free module reaching React through a barrel fails the check.
- **The Host lives in `@wincode/coding-agent`**, the private Coding-Agent Application package, in its own module reached through a declared subpath export. The split between the two factories is named so that "host" means exactly one thing: `createSessionHost` owns opening, the Engine, subscription, and shutdown, while `createSessionPorts` materializes Session Engine Ports from capabilities and owns no lifetime.
- **No separate session workspace package is created.** ADR-0027 places the Host in the application package; an independent package remains unnecessary until a genuinely reusable seam requires one.

## Considered options

- **Keeping construction in `useSessionEngine`** — rejected: the Engine stays
  reusable in principle and unreachable in practice, and every consumer
  re-derives opening, subscription, and teardown.
- **Opening as a Session Command** — rejected: a Session Command changes session
  state; opening establishes the state the Engine is born with, and a Command
  would force the Engine to carry an empty session it can never return to.
- **Opening through the Engine's granular setters** — rejected: `applyContext`
  and `mergeTranscript` exist for interruption and compaction, and opening
  through them would widen the setters ADR-0019 already records as the
  remaining exception instead of shrinking them.
- **A separate workspace package now** — rejected: ADR-0027 uses the Coding-Agent Application package as the existing non-interactive seam, so creating another package would add a boundary without a distinct contract.
- **Handing the non-interactive host Interactive Mode-shaped dependencies** — rejected: it would put `MutableRefObject` and provider types in a contract a non-React process has to satisfy, which is exactly the port surface ADR-0019 left as debt.

## Consequences

- ADR-0019's clause that the port surface is "the Interactive Mode's rather than a second host's" is superseded. The rest of that ADR — one owner, one command lane, per-execution scope — stands.
- The engine-host factory is renamed: it materializes Session Engine Ports from
  capabilities and owns no lifetime.
- Modules that mix React and React-free exports in one barrel must be split,
  because a React-free module importing such a barrel reaches React
  transitively. `modules/agents/registry.ts` is the known instance.
- Interactive Mode must render a session whose Host has not finished opening, because the Engine does not exist until opening completes. That asynchronous boundary belongs to the surface that mounts a session, so the binding stays synchronous and reads an already-open Host. The Engine's own constructor contract is otherwise unchanged.
- No composition root for capabilities outside React lands with the Host. A Host consumes capabilities as lazy getters, so the first non-React consumer composes them from the same React-free factories used by Interactive Mode; the application package owns that composition without introducing a second session package.
- The Host's declared subpath is now part of `@wincode/coding-agent`. ADR-0027 supersedes ADR-0011's package names while preserving the rule that help/version do not load the interactive application.
