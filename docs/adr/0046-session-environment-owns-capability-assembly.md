# Session Environment owns the capability assembly

Status: accepted

The capabilities a Session runs with were assembled at every call site that
needed them: Print and JSON Mode, the RPC runtime, the Session SDK, Interactive
Mode, and the SDK's child runtimes each resolved plugins, wired the store,
registry, compaction module, and Host Manager, and repeated a late-bound
`getSessionSdk` closure. That closure existed only to break the mutual
reference between Session Capabilities and the Session SDK, and its copies had
already drifted: one headless path handed the Session SDK the
capability-ceiling-applied Agent registry while the Interactive path handed it
the raw one.

## Decision

- One factory, `openSessionEnvironment({ policy, sources })` in
  `modules/sessions/host/session-environment.ts`, returns
  `{ capabilities, store, sessionSdk, waitForBackgroundWork, workspace, workspaceId, shutdown }`.
  It is the only place the capability graph is assembled for a mode, a process,
  or a view. The Session Host remains the composition root for one Session
  (ADR-0023): it opens a Session on an environment it is handed and does not
  build one.
- Split the input. `policy` is what the environment creates for the caller —
  cwd, workspace, database path, and Plugin policy.
  `sources` is what the caller already owns: configuration, Connections, Agent
  registry, Model Catalog pricing, Session Store, Session Host Manager, Plugin
  runtime, Agent Runtime factory, and turn tool resolver.
  The sources a Session's later work must see current — configuration, which a
  Resource Reload replaces, Connections, pricing, and the Plugin runtime
  Interactive Mode replaces on Resource Reload — are read when that work runs.
  The process-scoped ones are resolved once at open, except the Agent Runtime
  factory, which is forwarded and read when a turn needs a runtime. The Agent
  registry is resolved once at open when the caller supplies no source, and read
  per use when it does.
- Bind the Session SDK inside the environment, and resolve its mutual reference
  with the capabilities exactly once. The Plugin-facing `SessionSdkOperations`
  need the Session Store and Session Host Manager the capabilities own, while
  the capability that hands Plugin Tools those operations needs the operations,
  so one deferred reference resolves it — in the environment, not in every
  caller. `createSessionSdkInternal` keeps a second, structural one, where the
  SDK object and its own capabilities are mutually recursive inside a single
  function and the reference cannot be hoisted.
- Own only what was created. The environment closes the Plugin runtime it
  loaded from `policy.plugins`, the SQLite database it opened, and the Session
  Host Manager it created. An injected Plugin runtime, Session Store, or
  Manager stays the caller's, and `shutdown()` is idempotent, returning the
  same promise. Interactive Mode's Plugin runtime is process-scoped and
  replaced on Resource Reload, so a session-scoped shutdown must not close it;
  before that runtime exists the adapter lends a process-scoped stand-in, so a
  Host that outlives the view keeps a live runtime.
- Keep Plugin loading policy as input, not opinion. Callers that already hold a
  Plugin runtime pass it as a source. A caller that supplies neither a Plugin
  runtime source nor Plugin policy runs without Plugins, and the environment
  owns the empty runtime it creates — Interactive Mode has no process runtime
  before its startup finishes, and a plain-Node host may want none.
  `initializeApplicationRuntime` and the per-child-runtime loading inside
  `createSessionSdkInternal` keep their own calls, because their lifetimes and
  selection rules differ.
- Compose the headless modes once. Print, JSON, and RPC Mode share the
  application's Plugin policy — the distribution's packages, the invocation's
  Plugin selection, and the application turn tool registry — through one
  application-level composition of the environment. Interactive Mode composes
  its own from the providers it holds instead.
- Publish the environment as the package subpath `./session-environment` and
  remove `./session-capabilities`, which nothing imported. `./session-host` and
  `./session-rpc` keep their entries; `./session-rpc` now re-exports the Session
  Environment types instead of the capability assembly's own inputs, which are
  internal to the Session layer.

## Consequences

- One composition contract test pins the consumer-visible rules: managed versus
  injected shutdown, Plugin policy and its precedence, the bound Session SDK and
  the Host Manager it opens Sessions through, sources read lazily, compaction
  settings resolved through the current configuration and pricing, and
  `waitForBackgroundWork` delegation.
- A new Execution Mode or a plain-Node host composes a Session Environment
  instead of copying wiring.
- The Capability Ceiling is applied once and the same Agent registry reaches
  both the capabilities and the Session SDK, removing the Interactive-versus-
  headless disagreement.
- Interactive Mode keeps a React adapter that reads its providers and calls the
  same factory, so the TUI stops maintaining a second capability graph.
- A reconnected provider needs no rebuild to reach compaction: the Connections
  facade reads stored credentials per call, so the Session Compaction module
  keeps one admission record for its whole life.
