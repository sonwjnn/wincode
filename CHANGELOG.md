# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


- **Shell permission flips to a permissive posture (0.1.0).** Shell commands
  default to `allow` instead of `ask`; `rm *` and `sudo *` deny by default as
  overridable rules. Commands are matched as string globs and evaluated per
  command node via a tree-sitter parse (fail-closed), cd-family nodes are
  exempt, "Always allow" records the exact normalized command, and a doom_loop
  guard asks on the third identical tool call. The manual-approval safety
  ceiling is unchanged. See ADR-0008.

- **Read output is line-addressed.** Text reads now prefix every line with its
  1-indexed line number. Read targets accept single and multi-range selectors,
  preserve literal colon-containing paths, add bounded code context, and return
  a continuation selector when the output byte limit is reached.

- **Versioned single-file editing is available.** Read returns exact-byte
  File Versions, bounded private snapshots, and Seen Lines; hashline edits
  recover only provably safe drift, replace mode requires unique live text,
  sloppy mode is separately permissioned, and Write requires an expected
  version for overwrites.

- **Edit and Write transactions are recoverable across restart.** Every
  mutation now persists its canonical write set and original bytes before the
  first replacement. Interrupted commits create pinned Recovery Artifacts and
  block conflicting mutations until the new Recover Tool explicitly inspects,
  restores originals, keeps verified current bytes, or discards the artifact.
  Legacy full-content and compatibility Edit inputs are not accepted; this is a
  breaking protocol cutover.

### Features

- **A correction reaches a running Agent Turn before it ends.** A message sent
  while an Agent Turn runs joins a Steering Lane beside the Submission Queue and
  is delivered at the next Model Step boundary, inside that same turn: the model
  call in flight is never interrupted, so no Tool Call is torn from its request.
  It carries text only — the composer accepts plain text and refuses
  attachments, Skill and Custom Command invocation, and Agent changes while a
  turn runs — and it enters the Session Transcript as a user message of the turn
  it joined while the assistant output stays attached to the message that
  opened the turn. A tool-less turn has no boundary, so its Steering Messages
  fall back to the Submission Queue and run as their own Agent Turns. `Alt+Up`
  and `Shift+Up` recall both lanes, with `Shift+Up` taking whichever message
  runs next. See ADR-0022.

- **A submission written while the session is busy waits its turn.** Pressing
  Enter during a running Agent Turn or a compaction queues the submission
  instead of refusing it: a strip above the composer shows what is waiting, and
  the queue drains one Agent Turn at a time, oldest first, after every completed,
  failed, or cancelled turn. `Alt+Up` recalls the whole queue into the composer,
  `Shift+Up` takes back only the submission that runs next and leaves the rest
  draining, and Esc recalls the queue while it stops the running turn or cancels
  the compaction, so stopping work hands the waiting text back. A queued
  submission keeps the Agent, model, and variant it was accepted with, keeps its
  attachments alive while it waits, records itself into prompt history so a
  dropped queue is recoverable, and never survives a restart. While an Agent
  Turn runs, a message steers that turn instead — see the Steering Lane entry
  above — and only the sessions busy any other way still queue this way. See
  ADR-0021.

- **Tool resource profiles are configurable.** Set `resource_limits` to
  `standard`, `extended`, or `deep` globally or per Agent in `wincode.json(c)`.
  Elevated profiles allow larger bounded reads, searches, listings, shell
  commands, and edit previews; the first elevated call requests approval.

- **The Model Catalog carries a lifecycle.** Future product retirements can keep
  an entry in the Catalog as `retired`: the picker offers only `active`, while
  the retired entry remains readable for existing Session Records and normal
  sends refuse it. The 2026-09 cleanup was a separate clean cutover: obsolete
  OpenAI IDs were deleted after local session data was reset. See ADR-0012.

- **The Thinking Level picker offers only levels the model accepts.** Levels and
  their reasoning budgets resolve from one policy on the catalog entry instead
  of four hand-written resolvers, so a level that appears in the picker is one
  the runtime will send. Previously `high` and `max` sent an identical request
  because both fell back to the same hard-coded budget.

- **Model metadata is generated once, from one source, with provenance.**
  `bun run sync-model-metadata` writes a single snapshot covering reasoning
  policy, cost, limits, and cost tiers, reporting entries absent upstream
  rather than fabricating them; `--check` fails when the committed file is not
  what the current inputs produce. The offline generator and the runtime
  refresh share one converter, so a fact can only be interpreted one way, and
  the converter never imports its own output. See ADR-0014.

- **The session usage bar shows an estimated cost.** Estimated USD for the
  session appears beside the context measure as `~$0.00`, from the catalog's
  rates including cache read and write. It is labelled as an estimate and is
  never presented as billing. See ADR-0015.

- **The catalog covers newer models.** Added `claude-fable-5-1`, `claude-opus-5`,
  `gpt-6-astra`, and `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3.8-flash`.

### Changed

- **A Session Host opens a session and owns its lifetime, so a non-renderer can
  run one.** `createSessionHost` — reached through the declared
  `@wincode/coding-agent/session-host` subpath — reads a session's durable records,
  projects its Session Transcript, rebuilds its Session Context around the
  latest compaction, and constructs the Session Engine with them: it exposes the
  Engine, its Snapshot and subscription, the Agent Turn Events, the session's
  Session Selection, and one `shutdown`. Capabilities arrive as lazy getters and
  carry nothing React-shaped, so a plain Node process satisfies the same
  contract. The Coding-Agent application is now one such consumer: the route keeps what the
  navigation owns — which session to mount and the transient submission that
  starts its first turn — the session surface owns opening, the opening state,
  the failure that ends it, and the session title, and the binding reads an
  already-open Host and holds no session state. The engine-host factory is
  renamed `createSessionPorts` (it materializes the Engine's ports and owns no
  lifetime), the React-free boundary check walks from the Host entry as well as
  the Engine's, and the display
  annotation of attachments no longer reaches the Session Context. See
  ADR-0023.

### Removed

- **The dead `mid-turn` compaction surface.** The `mid-turn` trigger reason, the
  `midTurnEnabled` setting, and the `midTurnAvailable` availability flag are
  gone: nothing produced the trigger, the availability flag had no reader, and
  the setting had no effect. A threshold check that runs between Model Steps
  remains a `threshold` trigger if it is ever wanted.

- **OpenAI entries below version 5.6.** `o1*`, `o3*`, `o4-mini`, `gpt-5`,
  `gpt-5.1*`, `gpt-5.2*`, and `gpt-5.3*` are gone from the catalog. A session
  pinned to one of them refuses to send until the model is reselected. The TUI
  pricing cache also invalidates on upgrade, because its payload shape changed.

- **The generated variants and pricing snapshots.** `model-variants.generated.ts`
  and `model-pricing-snapshot.generated.ts` are replaced by the single model
  metadata snapshot; the two had drifted apart by construction.
