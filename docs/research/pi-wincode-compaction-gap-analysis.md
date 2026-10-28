# Pi → Wincode compaction gap analysis

## Scope

Comparison of current upstream Pi with Wincode checkout `134faaf6c74d2a8b699aebed76e98d3a2986e919`. Source investigation only; no product code changes. Upstream evidence is collected separately in [the upstream report](./pi-compaction-upstream-current.md). Older notes in this directory describe older Wincode layouts and are not used as evidence of current implementation.

## Upstream snapshot and comparison

Pi main was checked at [`3141dfdcf409e0bb2685a98ed298fa65920b1c7d`](https://github.com/earendil-works/pi/commit/3141dfdcf409e0bb2685a98ed298fa65920b1c7d). The researcher also checked published v1.4.0 at `4a080252f06caf63a525d7873c5d94d3c23887e0`: relevant compaction, agent-session and compaction-document blobs match. This is not a claim about the installed local Pi version.

| Capability | Pi at inspected upstream ref | Current Wincode | Recommendation |
| --- | --- | --- | --- |
| Context usage valid after compaction | Projected estimator invalidates usage measured before a later compaction/context edit | Retained assistant usage remains authoritative; false-positive recompaction reproduced | Fix first; separate measured context from billing and invalidate by durable boundary |
| Long tool-loop maintenance | Checks after settled tool batches before another assistant request | Checks before submission and after the whole Agent Turn | Add host-owned between-step context preparation; do not replay completed tools |
| Recovery | One compact/retry for eligible overflow or final length stop; persists omissions for the failed attempt | One eligible overflow recovery, refused after completed tool artifacts | Add continuation/checkpoint semantics before expanding eligibility; length stops need separate semantics |
| Per-model budgets | Exact provider/model reserve and recent-token overrides | One ordinary policy plus context-window clamps | Extend the central resolver and provenance, not callsite conditionals |
| Summary serialization | Omits thinking; tool results truncated to 2,000 characters | Reasoning serialized through generic path; 12,000-character generic non-text-part cap | Improve targeted serialization; input fit/chunking is an additional improvement, not a verified Pi guarantee |
| Cumulative file lists | Deterministic read/modified lists carried across default compactions | Prompted Relevant Files prose only | Persist cumulative metadata from central tool contracts |
| Plugin customization | Before/cancel/custom summary plus success/failure lifecycle events | Internal generator injection, no public compaction-specific hooks | Add bounded lifecycle contract after core correctness |
| Durability, repeat summaries, cancellation, tool-safe splits | Implemented | Implemented | Preserve existing strengths, do not rewrite merely for parity |

Primary Pi evidence: [boundary-aware estimators](https://github.com/earendil-works/pi/blob/3141dfdcf409e0bb2685a98ed298fa65920b1c7d/packages/coding-agent/src/core/compaction/compaction.ts#L120-L246), [between-step preparation](https://github.com/earendil-works/pi/blob/3141dfdcf409e0bb2685a98ed298fa65920b1c7d/packages/coding-agent/src/core/agent-session.ts#L750-L925), [recovery](https://github.com/earendil-works/pi/blob/3141dfdcf409e0bb2685a98ed298fa65920b1c7d/packages/coding-agent/src/core/agent-session.ts#L2995-L3330), [serialization/file tracking](https://github.com/earendil-works/pi/blob/3141dfdcf409e0bb2685a98ed298fa65920b1c7d/packages/coding-agent/src/core/compaction/utils.ts#L1-L130), [model budgets](https://github.com/earendil-works/pi/blob/3141dfdcf409e0bb2685a98ed298fa65920b1c7d/packages/coding-agent/docs/settings.md#L64-L95), [extension contract](https://github.com/earendil-works/pi/blob/3141dfdcf409e0bb2685a98ed298fa65920b1c7d/packages/coding-agent/src/core/extensions/types.ts#L775-L850).

Important distinctions:

- Pi's raw `estimateContextTokens(messages)` is not itself boundary-aware; its projected estimator and AgentSession call paths supply the missing invalidation. Copying just the raw helper would not fix Wincode.
- Pi's recovery is not all-or-nothing: failed-attempt omission edits survive failed/cancelled recovery compaction. Do not assume its persistence strategy is universally safer than Wincode's.
- A general summary-input fitting/chunking loop was not established for Pi. Claim only the verified reasoning omission/tool-result truncation advantage.
- OpenAI OAuth blocking is a confirmed Wincode capability-policy limitation; the upstream research did not establish end-to-end Pi OAuth output-bound guarantees. Treat summary-model routing as a product improvement, not proven parity.
- The upstream researcher's uncertainty about the stale-usage reproduction concerns independent replication only: the reproduction was executed by the parent against Wincode exports, not Pi's projected estimator.

## Wincode baseline (verified locally)

Already implemented:

- Manual `/compact` with focus; automatic pre-submission threshold checks and post-successful-Agent-Turn maintenance. See `packages/coding-agent/modules/sessions/agent-session/submission.ts:231–279,1134–1176,1323–1340`.
- Provider-usage-plus-unmeasured-suffix estimates, including cached input via the central AI usage helper. See `modules/sessions/compaction/config.ts:533–593` under `packages/coding-agent`.
- Durable summaries and kept boundaries, repeat-compaction prior summary, resume reconstruction, complete tool-pair boundaries, oversized assistant-part splitting. See `modules/sessions/compaction/compaction.ts:96–143,370–688,1000–1098` and tests in `test/sessions/compaction.test.ts`.
- One summary attempt with bounded output, minimum viable budget, strict reduction/safe-threshold acceptance before persistence. See `compaction.ts:843–879,1156–1180,1217–1267`.
- Same-intent deduplication, different-intent refusal, cancellation, persistence error handling and host-authority check before appending. See `compaction.ts:1180–1186,1262–1316` and `modules/sessions/host/agent-session-adapters.ts:294`.
- One eligible overflow recovery per original user message, no duplicated original user prompt, and refusal to replay after completed tool artifacts. See `modules/sessions/agent-session/maintenance-workflow.ts:343–475`.
- Explicit media retention limits and durable attachment metadata rather than blindly replaying raw old attachments. See `compaction/config.ts:29–39`, `compaction/compaction.ts:787–838`, `compaction/summary-message.ts`.
- Structured handoff preserving goals, constraints, pending requests, verification and Git state, with untrusted-data framing. See `compaction/summary-generator.ts:20–119`.

## Confirmed correctness gap: stale usage after compaction

`estimateSessionContextTokens()` selects the latest retained assistant usage without checking whether that measurement belongs to the current context version (`config.ts:544–567`). `compact()` and `rebuildActiveMessages()` retain assistant metadata across the context replacement (`compaction.ts:96–143,1187–1191`). `needsCompaction()` then uses the stale measurement (`compaction.ts:1306–1314`).

### Executed reproduction

Using the actual `createSessionCompaction`, `estimateSessionContextTokens`, `estimateCompactionTokens`, and `rebuildActiveMessages` exports:

1. Construct two user/assistant pairs. First pair contains 40,000 text characters. Latest assistant has usage `{inputTokens: 90000, outputTokens: 100}`.
2. Compact with a stub summary generator returning `Short summary.`, `keepRecentTokens: 200`, `thresholdTokens: 80000`.
3. Compare the active-context fallback estimate, threshold estimate, and threshold predicate, both immediately and after reconstruction.

Observed:

```json
{
  "tokensBefore": 90100,
  "estimatedTokensAfter": 32,
  "activeFallbackEstimate": 32,
  "activeThresholdEstimate": 90100,
  "needsCompactionAgain": true,
  "afterReopenNeedsCompaction": true
}
```

This proves a false-positive re-compaction decision, not an infinite-loop claim. Depending on retained history the next attempt may instead fail as history-too-short/not-needed. A genuinely new provider measurement can correct the value later.

**Recommended invariant:** a provider usage measurement is authoritative only for the context projection/version it measured. After replacing context, use an explicitly marked estimate until a request against the new projection yields usage. Keep old usage in the transcript for billing; do not erase financial history to fix context metrics. Persist/reconstruct the validity boundary so reopen behaves identically.

## Related accounting issue: turn billing usage is not context usage

The runtime accumulates `totalUsage = sumUsage(totalUsage, output.usage)` across model steps and emits it on `agent-turn-completed` (`packages/agent-core/src/agent-runtime.ts:880–890,910–917`). Session projection stores this aggregate in the assistant's `metadata.usage` (`packages/coding-agent/modules/sessions/agent-session/turn.ts:224–232,296–307`). The compaction estimator reads that same field as if it described one current context (`compaction/config.ts:551–556`).

For a tool loop with several similarly sized requests, summing their input tokens measures cumulative billed work, not the final request's context occupancy. This can trigger compaction too early even without a previous compaction. Follow-up Phase 1 exploration now confirms this with the real offline runtime: steps measuring 10,004 and 14,003 produce aggregate usage 24,007, which both threshold and UI incorrectly report as context. See [the Phase 1 exploration](./compaction-accounting-phase1-exploration.md) for reproduction, controls, proposed lineage/coverage contract and tests.

**Recommended contract:** keep cumulative billing usage and the latest measured model-step context usage as separate values. A context measurement should carry its model identity and context version/anchor. Regression tests should cover multi-step input accumulation, cached tokens, post-compaction invalidation, and reopen.

## Other confirmed Wincode boundaries

### No between-model-step compaction seam

`runTurn()` delegates the entire tool/model loop to `turnRunner.run()` and invokes `maintainAfterTurn()` only once the full Agent Turn returns successfully (`submission.ts:1178–1340`). Runtime options expose observers and steering, not a context-preparation/replacement callback before the next model step (`packages/agent-core/src/runtime.ts:154–185`). A long tool loop can exceed context before post-turn maintenance runs.

The existing overflow safeguard refuses automatic replay if this attempt has completed tool artifacts (`maintenance-workflow.ts:358–371`). This is a safety feature, not something to delete: a recovery redesign must preserve completed side effects and continue from a safe checkpoint rather than rerun the original user task.

### No model-specific compaction budgets

Settings resolve one ordinary reserve/recent budget, with small-window clamps and optional resolver-level session overrides; no `provider/modelId` override map (`compaction/config.ts:29–98,309–381`). The service resolver supplies context limit and config snapshot but no dedicated summary-model routing (`compaction/settings-operations.ts:38–60`).

### OpenAI OAuth is intentionally unsupported for bounded summaries

`createProviderSummaryGenerator()` requires `collection.canEnforceMaxOutputTokens()` and throws before network I/O for OpenAI OAuth (`summary-generator.ts:215–234`). The OpenAI provider also rejects a requested output maximum for OAuth (`packages/ai/src/sdk-providers/openai.ts:246–253`). This is defended explicitly by `test/sessions/summary-generator.test.ts:113–153`.

Any proposed support must be a deliberate capability-policy change. A safe first option is explicit summary-model selection with an enforceable output limit; do not silently ignore the bound or silently switch credentials/models.

### Summary request size and reasoning serialization

`serializePart()` directly returns text and JSON-serializes other parts; the generic non-text cap is 12,000 characters per part. This includes reasoning parts through the generic path (`compaction.ts:47,320–363`). `SummaryGeneratorInput.serializedMessages` has no request-input budget (`compaction/types.ts:77–86`), and output budgeting subtracts retained context/scaffolding rather than bounding the actual serialized summarization input (`compaction.ts:843–879,1238–1256`).

Improvement: omit reasoning from the summary request, use a semantically targeted tool-result serializer, and fit the final serialized request including XML escaping, prior summary, focus and scaffolding. If implementing chunked summarization, preserve exact current constraints/pending requests and fail atomically. Per-part truncation is not a proof of whole-request fit.

### File history depends on the model's prose

The prompt asks for Relevant Files, but `CompactionSummary` stores no deterministic read/modified file sets (`summary-generator.ts:32,64–65`, `types.ts:25–32`). A search across current domain modules found no cumulative `readFiles`/`modifiedFiles` tracker. For an implementation, first locate the central coding-tool input/path contracts; do not hardcode duplicate path parsers at the compaction callsite.

### No public compaction lifecycle extension contract

The public Plugin API has session start/shutdown, before-Agent-Turn and process lifecycle hooks, but no before/success/failure compaction hook (`modules/plugins/public.ts:241–281`). Internal `SummaryGenerator` injection is not an equivalent consumer-facing Plugin hook.

If added, the host must continue to own authorization, safe boundaries, budgets, persistence and context publication; plugin output is not a license to bypass those checks.

## Proposed delivery slices

1. **Context accounting first.** Separate last-model-step context usage from accumulated billing usage; invalidate measurements on compaction/context replacement; reconstruct validity on resume. Preserve full transcript billing history. Acceptance: no false re-compaction after a successful compact, accurate context after a multi-step tool loop, cache tokens counted once per measured request, same results after reopen.
2. **Summary-request safety.** Omit reasoning, bound tool-result serialization and budget the final summary request, not just its output. Add explicit capability-aware summary-model selection if OAuth users need compaction. Acceptance: oversized inputs fail safely or are deliberately chunked; no durable partial entry; no silently dropped constraints or unbounded-output fallback.
3. **Model-specific policy.** Resolve exact provider/model reserve/recent overrides through the existing settings resolver and provenance system. Acceptance: switching models changes subsequent policy; an in-flight compact keeps its captured policy; invalid entries are diagnosed and manual/automatic/recovery paths resolve identically.
4. **Between-step continuation.** Introduce a narrow runtime capability for host-owned context preparation before a subsequent model call, after tool settlement. Keep `agent-core` generic: no coding-agent compaction policy inside the low-level engine. Acceptance: completed tools are not rerun, call/result pairs survive, steering is neither lost nor duplicated, stop-tool behavior and cancellation remain correct.
5. **Durable handoff metadata and hooks.** Add cumulative file-operation metadata and a bounded Plugin compaction lifecycle contract. Acceptance: repeated compaction preserves deterministic paths; hook cancellation/failure produces one terminal outcome; custom summaries still pass host validation.

These are proposed slices, not approved implementation scope. Start with accounting regardless of the order selected for later capability work.

## Validation

Initially targeted tests could not resolve `@wincode/utils` because its generated `dist` was absent. Ran the existing `bun run build:utils` bootstrap, then:

- `bun test test/sessions/compaction.test.ts test/sessions/compaction-submission.test.ts test/sessions/overflow-recovery.test.ts test/sessions/compaction-config.test.ts`: **48 pass, 0 fail**.
- `bun test test/sessions/summary-generator.test.ts test/sessions/compaction-schema.test.ts test/commands/compaction-command.test.ts`: **12 pass, 0 fail**.
- Executed stale-usage reproduction against actual local exports: **confirmed**, including reconstruction.

No full Default/E2E portfolio, provider-network verification, or typecheck was run. No product source changes were made.
