# Phase 1 exploration: separate context occupancy from billing usage

## Status and scope

Exploration against Wincode `134faaf6c74d2a8b699aebed76e98d3a2986e919`. The investigation below predates the implementation; see the follow-up status at the end. This note refines [the Pi comparison](./pi-wincode-compaction-gap-analysis.md).

Two defects were reproduced against actual Wincode exports, including a real two-model-step runtime backed by an offline scripted Provider. Proposed interfaces below are a design recommendation, not shipped types.

## 1. Executed feedback loops

Machine-local diagnostic harness: `/tmp/wincode-phase1-accounting-debug/repro.mjs`. Run from `packages/coding-agent`:

```sh
bun /tmp/wincode-phase1-accounting-debug/repro.mjs stale
bun /tmp/wincode-phase1-accounting-debug/repro.mjs multistep
```

Both deliberately exit 1 on the existing bug. They use fake offline credentials, make no external provider request, and write no session database.

### A. Stale measurement after compaction

Actual compactor + rebuild, two user/assistant pairs, latest assistant usage 90,100, threshold 80,000:

| Observation | Result |
| --- | ---: |
| Current compacted context fallback estimate | 32 |
| Threshold checker estimate | 90,100 |
| Needs another compaction immediately | true |
| Needs another compaction after rebuild | true |
| Control: ignore retained old usage, estimate current context | 32 |
| Original transcript usage after control | preserved, 90,100 |

The control changes only usage eligibility in a cloned active context; it does not modify the transcript. This establishes invalid measurement selection, not a faulty summary-size calculation. It does not prove an infinite compaction loop.

### B. Aggregate turn usage mistaken for current context

Actual `createAgentRuntime()` emits a `read` call on step 1 and final text on step 2. Real `projectAgentTurnEvent()`/`projectAgentTurnTerminal()` feed the resulting messages into the compaction estimator and usage presenter.

| Observation | Result |
| --- | ---: |
| Step 1 usage | 10,000 input + 4 output |
| Step 2 usage | 14,000 input + 3 output |
| Latest request measurement expected for context | 14,003 |
| Aggregate turn usage, appropriate as a token-work total | 24,007 |
| Actual threshold context | 24,007 |
| Actual UI context | 24,007 |
| Threshold | 20,000 |
| Expected / actual needs-compaction | false / true |

Control: replace projected assistant `metadata.usage` with the final step usage. Context becomes 14,003, but doing the same to billing metadata loses 10,000 input tokens (and step 1's output). Therefore replacing the aggregate field is not a valid fix.

The latest usage measurement is a provider observation of its request/response, not a guarantee of exact occupancy for a future request after prompt/tool/media changes. Call it measured versus estimated; do not promise exact provider tokenization.

## 2. Hypotheses and evidence

1. **Wrong metric selected:** terminal usage aggregates model steps; consumers treat it as one context measurement. Confirmed by real runtime repro and replacement control.
2. **Missing projection validity:** compaction changes context without invalidating measurements retained in the tail. Confirmed by actual compactor, ignore-old-usage control and rebuild.
3. **Persistence lacks the distinction:** both live/durable metadata have only `usage`, and conversion explicitly copies only recognized fields. Source-confirmed; a new in-memory field alone will not survive resume. A round-trip test for the new contract is required during implementation.

## 3. Current producer/consumer trace

Paths below are relative to the repository root.

| Seam | Current behavior | Evidence |
| --- | --- | --- |
| Per-model-step producer | Emits individual step usage | `packages/agent-core/src/events.ts:69–76`, `agent-runtime.ts:875–883` |
| Turn-total producer | Sums step usage and emits aggregate on completion | `packages/agent-core/src/agent-runtime.ts:309–351,883–917` |
| Live session projection | Stores terminal aggregate in assistant metadata | `packages/coding-agent/modules/sessions/agent-session/turn.ts:208–235,284–313` |
| Durable terminal synthesis | Stores terminal aggregate in record metadata/outcome | `packages/coding-agent/modules/sessions/turn-records.ts:79–188` |
| Runtime consumer | Already sees individual `model-step-finished` events; persists terminal checkpoint before terminal publication | `packages/coding-agent/modules/sessions/hooks/runtime-turn.ts:790–924` |
| Persistent metadata contracts | Have aggregate `usage`, no separate context measurement | `packages/agent-core/src/records.ts:108–140`, `packages/coding-agent/modules/sessions/message.ts:151–170` |
| Serialization/projection | Explicitly copies `usage` in both directions | `packages/coding-agent/modules/sessions/storage/session-record.ts:274–305,403–437` |
| Threshold estimate | Reads latest assistant usage + estimates messages after it | `packages/coding-agent/modules/sessions/compaction/config.ts:533–571` |
| Recompaction decision | Calls that estimator, no epoch/boundary argument | `packages/coding-agent/modules/sessions/compaction/compaction.ts:1306–1315` |
| Post-run maintenance | Supplies transcript, not active context, to threshold predicate | `packages/coding-agent/modules/sessions/agent-session/submission.ts:1134–1176,1323–1340` |
| UI usage summary | Uses one message array for both latest context measurement and all billing | `packages/coding-agent/modules/sessions/usage/session-usage.ts:44–61,95–198` |
| UI callsite | Calls summary with display/transcript messages | `packages/coding-agent/modules/sessions/ui/components/chat-shell.tsx:324–340` |
| Other UI consumer | Separately calls same summary from sidebar | `packages/coding-agent/modules/sessions/ui/components/session-sidebar.tsx:28–40` |
| Resume | Restores records, compactions, then rebuilds context | `packages/coding-agent/modules/sessions/host/session-host.ts:214–269` |

`getModelContextTokens()` is simply input + output (`packages/ai/src/model-usage.ts:86–88`). It is not responsible for discovering whether its input describes one request or an aggregate. Cached reads/writes are subdivisions of canonical input tokens, not extra context tokens to add again.

## 4. Recommended ownership and interface

### Three distinct facts

1. **Billing usage:** existing aggregate turn usage and auxiliary usage entries. Historical accounting survives compaction unchanged.
2. **Context measurement:** one latest model-step provider observation, with model identity, source step and projection lineage/coverage.
3. **Current context estimate:** a derived result over the actual Session Context, using a valid measurement only when its coverage is known, otherwise estimating current content.

Do not create a second live state owner. Agent Session remains the application-level coordinator; Stateful Agent owns live execution. Follow ADR-0035's ownership split. Coding-specific compaction policy stays out of agent-core.

### A small shared context-accounting module

Move/generalize the current estimator into the sessions usage/context domain. Its interface should consume the current context, requested model and projection lineage and return a tagged estimate, conceptually:

```text
ContextUsage
  tokens
  source: measured | mixed | estimated
  measuredBy: optional model-step identity
  model: exact provider/model identity
```

These are proposed domain fields, not final TypeScript names. `mixed` means valid measured context plus an estimated unmeasured suffix. It is not safe to label that total exact.

All compaction threshold checks, `tokensBefore`, and UI context presentation consume this result. Billing continues to consume the entire transcript plus usage-only entries. The UI must not recompute context from `displayMessages`.

A `LiveSessionSnapshot` projection or explicit context-result input to the presenter can distribute the computed result. It must be derived from authoritative session state, not independently mutable React state.

### Capture existing events; do not change runtime aggregate semantics

`model-step-finished` already exposes per-request usage. The live projector and durable runtime consumer should record that separate observation. Keep terminal `event.usage` and existing billing `metadata.usage` as aggregate totals. A new context-measurement value needs to flow through:

- live SessionMessage metadata;
- terminal record synthesis (including the consumer's captured latest step);
- core durable metadata types/validation;
- storage conversion in both directions.

No new runtime event is needed merely to learn per-step usage. Do not repurpose the cache-warming `ModelStepObserver` as a second authoritative session state writer; it is explicitly best-effort and currently used for warming behavior.

### Persist measurement lineage

**Recommended:** capture a projection epoch when the model request starts and retain it with its measurement. For Phase 1, the current compaction identity can define the durable post-compaction epoch; an explicit initial epoch covers sessions before compaction. Compare measurements to the current projection epoch, not their wall-clock timestamps. A new compaction invalidates old samples, even if the message containing them is retained.

If the marker is stored as durable generic context-lineage metadata, agent-core must not import the coding-agent `CompactionId` type. The application supplies opaque lineage; core owns only provider-neutral record shape. Existing records without a separate valid measurement are estimated; aggregate usage must never be treated as a fallback context sample.

Other context-replacement/sanitation operations must either preserve a proven-valid measurement or explicitly invalidate it. The compaction ID is not a universal content fingerprint.

**Alternative:** persist the last observed message/record high-watermark on every compaction, then ignore measurements through that position. This can work, but adds durable boundary data and requires correct ordering for split assistant messages, retries and resume. The current `throughMessageUiId` is the summarized prefix endpoint, not the last pre-compaction measurement, so it is insufficient by itself.

**Rejected:** RAM-only validity flag, timestamps, discarding all future measurements forever once a summary message exists, overwriting billing usage, or ignoring only the synthetic summary's own usage. None establishes the full live/resume contract.

### Important coverage trap

`model-step-finished` is emitted **after tools execute**, but its provider usage measured the model response **before those tool results were appended** (`agent-runtime.ts:858–881`). In SessionMessage projection, a tool call/result may share one part. Consequently:

- capturing `parts.length` at `model-step-finished` does not prove all those parts were measured;
- selecting a new sample and blindly skipping the entire assistant message can miss tool results;
- steering can append further model input after that sample;
- a stop-tool batch can terminate without another model call to measure the new results.

Phase 1 must either represent the unmeasured suffix correctly or conservatively estimate the complete current context when coverage is ambiguous. Do not ship a confidently wrong measured number just to preserve the fast path. Full mid-run precision and between-step compaction remain Phase 3 work, but terminal tool-only cases must not regress now.

### UI semantics

Recommended: show measured/mixed/estimated provenance explicitly (for example, an estimate marker after compaction), while preserving session cost/cache totals. Before any provider measurement, retain the existing hidden-bar behavior unless intentionally changing that UX.

A minimal alternative is to show context as unknown after invalidation until a new matching measurement arrives. That is truthful but less helpful than a labeled estimate. Do not display a stale value as current just because the current UI previously promised provider-only measurements.

After a model switch, do not pair the old model's measurement with the new model's context limit as if measured for that model. Use explicit provenance or estimate under the requested model. The existing presenter intentionally uses the last completed model; changing that presentation must be deliberate.

## 5. Intended state transitions

| Event | Context metric | Historical billing |
| --- | --- | --- |
| New terminal request observation, matching lineage and complete coverage | measured | existing aggregate retained |
| Additional unmeasured user/tool/steering content | mixed if coverage known, otherwise estimated | unchanged until normal usage commit |
| Successful compact/context replacement | estimated under new lineage | unchanged; summary usage accounted through existing paths where applicable |
| Fresh model request against compacted context | matching new measurement may become authoritative | normal turn-total accumulation |
| Compaction failure/cancellation before a published context change | prior valid metric remains usable | unchanged |
| Reopen | derive same lineage and eligibility from durable data | same historical totals |
| Cache-warm/summary-only auxiliary usage | must not become main conversation context measurement | included only through applicable accounting path |
| Missing/ambiguous usage or coverage | estimate, never silently inherit aggregate usage | retain available historical usage |

No database-wide migration system is proposed. If implementation adds SQL fields rather than JSON metadata, use the repository's schema push/reset policy, not compatibility migrations.

## 6. Delivery slices and regression contracts

### 1A — Separate the observation, preserve accounting

Capture the last model-step measurement and persist/project it separately from aggregate usage. Make the central estimator prefer only that explicit observation.

Required behavior: a 10,004 + 14,003 two-step run reports context 14,003 at its fully measured endpoint while retaining aggregate work 24,007. Test the real runtime → projection → presenter path, not just a manually built metadata object.

### 1B — Projection validity, compaction and reopen

Add durable lineage, consume actual context rather than transcript, and make both live/rebuilt estimators invalidate pre-compaction samples. Wire new fields through record schemas and conversions before claiming restart correctness.

Required behavior: successful compaction does not immediately request another compact solely due to an old measurement; a subsequent fresh request can restore measured status; reopening preserves both results.

### 1C — Presentation and boundary coverage

Make context UI and compaction share the same context result, while billing reads historical inputs separately. Handle or conservatively fall back for tool-only terminal batches and steering suffixes. Mark estimated/mixed values.

Additional contract-first tests:

- cached input is counted once in context, never subtracted and never added twice;
- cache warming and summary requests do not replace the main-context sample;
- no-usage last step does not masquerade as fully measured context;
- record conversion preserves context measurement and lineage;
- retained/split assistant metadata cannot revive an old measurement;
- failed/cancelled compaction does not publish a new epoch;
- failed persistence does not publish fresh authoritative context state;
- pending/failed steering messages excluded from model context do not inflate its estimate;
- model-switch presentation does not combine an old measurement with an unrelated new limit;
- repeated compact/reopen/fresh-response cycles converge without false positive threshold decisions;
- normal cost/cache totals remain unchanged by context invalidation.

Existing pricing from aggregate turn usage, provider invoices, and durable billing for partially failed turns are separate accounting questions; this phase does not claim those are solved. In particular, do not expand this patch into a new per-request billing ledger without an explicit scope decision.

## 7. Validation performed

Existing suites on unchanged product code:

```sh
# packages/coding-agent
bun test test/sessions/compaction.test.ts test/sessions/compaction-submission.test.ts test/sessions/session-usage.test.ts
# 55 pass, 0 fail

# packages/agent-core
bun test test/agent-runtime.test.ts
# 18 pass, 0 fail
```

The two diagnostic commands intentionally report the existing bugs with exit 1; they are not fixed regression tests. The original comparison's source-only multi-step suspicion is now confirmed by the real offline runtime reproduction.

At the exploration snapshot, no implementation, SQL schema change, full test portfolio, E2E portfolio or typecheck had been performed.

## 8. Implementation follow-up

Phase 1 now captures an explicit `contextMeasurement` (request usage, step identity and projection epoch) separately from aggregate billing. The compaction summary identity defines the current epoch. The runtime consumer and live projection capture existing model-step events; core durable metadata validation and storage conversion preserve the observation. No SQL schema change or migration is needed.

A shared context estimator supplies threshold decisions, pre-compaction token counts and UI occupancy. Post-turn maintenance checks the active Context, not the Transcript. UI cost/cache totals still use historical billing; approximate context gets a `~` marker. Foreign-model samples and aggregate-only historical metadata are not accepted as current measurements.

For a last step with tools or missing usage, the application deliberately omits the sample and estimates rather than claiming the new tool results were measured. This does not add between-step compaction or a per-request billing ledger.

Regression tests exercise the real two-step runtime, live/durable projection, metadata validation/round-trip, repeated compaction and rebuild, billing preservation, auxiliary warm usage, model switches and approximate UI rendering. Initial regressions failed at 24,007 versus 14,003 and at the second compaction reading 90,607 versus 40,010.

Validation before independent review: `bun check-types`, `bun fix`, Default portfolio (1,821 pass), E2E portfolio (35 pass). No product tests are knowingly failing.
