# Coding-Agent → AI SDK migration plan

Design only. ADR-0049 is the accepted target; PR #198 shipped the standalone SDK but did not migrate Coding-Agent. This plan defines implementation tickets and contract-first acceptance tests; it does not authorize deleting any real credentials or changing the running application now.

## Invariants across the cutover

- The persisted Session Record keeps its `{providerId, modelId}` and usage; a missing model is displayed under its stored IDs but is not silently substituted or invoked, including for compaction.
- The Stateful Agent continues to own the Tool Call loop, Agent Turn event order, abort semantics, Steering Messages and continuation. One successful SDK terminal outcome completes one Model Step; failure or abort never becomes success. Coding-Agent never persists a credential in a Session Record.
- Auth-aware availability is **not** health. Known/discovered models survive offline restores and failed refreshes. A Provider ID collision, changed Plugin registration owner, or missing default must never redirect requests or disclose a credential to a different Provider.
- No legacy secret is deleted before the cutover implementation and its deletion tests are reviewed. Once enabled, deletion is a one-way, fail-closed, retryable gate; Session history and attachments remain intact.

## Dependency-ordered tickets

| ID | Scope | External contract to defend | Prerequisite |
| --- | --- | --- | --- |
| M1 | SDK chat capabilities | Public `chat()` carries provider-neutral effort/output limit/cache key and optional warming, preserves tool failures/opaque continuation and normalized terminal errors; Node and Bun fake-provider consumers exercise each control. Unsupported cache preference stays best-effort. | ADR-0049 |
| M2 | Application stores and destructive cutover | A fake OS store + file fallback with different legacy secrets is fully deleted and verified before the new namespace is enabled. Partial failure reports *identifiers/status only*, blocks every execution mode, never claims rollback, and retry completes idempotently. New CredentialStore serializes writes/refresh; ModelStore commits snapshots atomically under abort and keeps previous results on failure. | M1 for integration; storage contract can be implemented/tested independently |
| M3 | Plugin registration and connection | A trusted Plugin registers a Provider factory and connect interaction; built-in or Plugin ID collision fails; stored Plugin ID + trusted source identity prevents cross-project secret reuse. Headless modes return actionable noninteractive auth errors; absent Plugin keeps data quarantined. Candidate `/reload` takes effect only at idle, rolls back when safe, and cannot revive newly untrusted code. | M2 |
| M4 | Agent Runtime SDK boundary | Replace ModelClient/ModelStepRequest and secret-bearing ModelTarget with `{providerId, modelId}` SDK requests. Contract tests assert text/reasoning/tool/usage events, continuation, errors, abort and cache accounting across multiple Model Steps and late Steering Messages. No lasting compatibility adapter. | M1, M3 |
| M5 | Host and mode composition | Each Session Host creates its own ProviderCollection/instances and closes Google CachedContent on unload; credential/model stores are shared by user, refresh applies at next turn. TUI, one-shot, JSON, RPC, compaction and delegated Sessions all use the same runtime; children load only explicitly selected Plugin paths. Explicit OAuth/browser interaction remains possible in Interactive Mode. | M2–M4 |
| M6 | Selection, settings and historical display | Model picker, defaults, Agent pins, Plugin `setModel`, Session restore, thinking/cache menus, pricing and compaction consume Provider Models instead of the static catalog. Absent model IDs stay visible but sends/compaction require explicit reselection; unknown cost is unknown and absent context limit disables threshold-based auto-compaction. | M3, M5 |
| M7 | Removal and documentation cutover | Remove obsolete Connections facade/registry/vault, Model Catalog policy and Model Target paths after all consumers move; relocate any credential schema/protocol helper the SDK still needs before deletion. Supersede ADR-0012's allowlist rule, update the glossary from transitional to current language, onboarding docs and package exports. | M1–M6 |

These are *ticket candidates in this document*, not GitHub issues. No branch push or remote issue was created by this design-only work.

## Integration gates

1. In a fresh tree based on merged `master`, write failing public SDK/Session behavior tests before each implementation slice. Use fake transports, fake OS secret backend, temp file fallback and temp user-scoped stores; never test with real keys or live provider endpoints.
2. Prove safe credential deletion under: only OS secret, only file fallback, both, inaccessible backend, deletion failure after earlier deletion, verification failure, process restart mid-gate, and idempotent retry. No log, error or snapshot may contain a secret value. Test CLI/JSON/RPC fail-closed behavior without corrupting stdout protocols.
3. Prove Plugin trust boundaries across two workspaces with the same Plugin ID from different sources, a disabled Plugin, provider collisions, a failed `/reload`, trust revocation, and explicit child Plugin selection. Prove shared stores do not cause cross-Host Google cache reuse.
4. Test full Session history: old ID still displays after model removal; model missing from current provider list refuses new sends and compaction; offline restored model list stays distinct from remote reachability; discovery updates do not redirect an in-flight turn; no automatic default substitution.
5. Run `bun fix`, `bun check`, `bun check-types`, `bun run test` and `bun run test:e2e`; investigate any failures rather than assuming they predate this migration. Independently review the complete base-to-candidate diff and destructive-operation test evidence before integration. Do not push or commit unless explicitly requested.

## Explicitly out of scope

Image generation/classification; a declarative provider protocol config; silently importing old credentials; automatic login in one-shot/RPC; inferring missing price/context/reasoning metadata; changing historical Session Record identity; and maintaining two permanent model-invocation paths.
