# Phase 2 exploration: summary safety, model policy and routing

## Scope and status

Source exploration began at Wincode `49a26ef9` on `perf/compaction`, before the implementation described below. At exploration time, no product source or repository tests had changed. This follows [Phase 1](./compaction-accounting-phase1-exploration.md) and [the Pi comparison](./pi-wincode-compaction-gap-analysis.md).

Phase 2 should distinguish three concerns: preparing a bounded summary request, keeping its result safe for the conversation model, and resolving explicit policy/summary-model selection. They cannot be represented by one generic context limit.

No fresh upstream parity claim is made here. The findings below use the current local source and offline probes.

## 1. Reproduced findings

Machine-local, disposable diagnostic harness: `/tmp/wincode-phase2-compaction-debug/repro.mjs`, run with Bun from `packages/coding-agent`. It uses the actual serializer, compactor, summary generator, SDK collection and host-adapter factory. Provider calls are local scripted events with fake credentials, not network I/O. Stores are in-memory.

```sh
bun /tmp/wincode-phase2-compaction-debug/repro.mjs
```

It intentionally exits 1 on the confirmed unsafe/missing behaviors.

### A. Summary input is not fitted to its request limit

An old user message containing 40,000 ampersands becomes a request of **202,014 characters** after XML escaping plus prompt/system scaffolding. The selected model declares an **8,192-token context** and a **1,024-token output cap**.

The actual summary generator dispatched one request and the compactor persisted one entry. Using the repository's existing characters/4 convention gives an estimated prompt of **50,504 tokens**, or **51,528 with reserved output**.

This is not an exact provider-tokenizer measurement. The scripted Provider deliberately accepts the request, proving the absence of an application-level input-fit guard, not that a real Provider would accept an oversized request.

Sources: `modules/sessions/compaction/compaction.ts:842–879,1243–1252`; `summary-generator.ts:98–114,216–239` under `packages/coding-agent`.

### B. The effective output limit can violate the planner's minimum

With a selected model declaring `maxOutputTokens: 128`, the compactor's initial budget passes its **256-token viability floor**, but `createProviderSummaryGenerator()` later clamps the actual request to **128**. A nonempty result is still persisted.

Probe: one dispatch, `actualOutputCap: 128`, one persisted entry. The planned minimum and the effective request are checked in different places and disagree.

Sources: `compaction.ts:1228–1237`; `summary-generator.ts:216–224`. Existing summary-generator tests intentionally verify the SDK-model clamp, but not its composition with compaction's viability rule.

### C. Generic JSON truncation can remove tool outcomes

The serializer includes reasoning text. A terminal shell part with a long input followed by `state: "output-error"` and an error message retains its Tool Call ID but loses the error/outcome after the 12,000-character JSON prefix cut.

Probe: `reasoningIncluded: true`, `toolCallIdIncluded: true`, `outcomeIncluded: false`, `truncated: true`.

This depends on field order, even though the meaning of a tool part should not. Truncate payload sections, not the whole semantic envelope.

Source: `compaction.ts:325–362`.

### D. A repeated compact can increase the actual current context

Actual compactor, two successive summaries, full Transcript supplied as in normal maintenance:

```text
current projection before second compact: 1,035 estimated tokens
new context after second compact:          1,275 estimated tokens
persisted compactions:                    2
```

The strict-reduction check compares against the much larger source Transcript instead of the current projection reconstructed from the previous compaction. Phase 1 correctly reports `tokensBefore` for that projection, making the mismatch visible, but the acceptance guard still uses the source messages.

Source: `compaction.ts:1165–1172` versus its current-projection `tokensBefore` calculation. Fix the guard using comparable fallback estimates of the actual before/after projections; do not compare measured usage on one side with heuristic estimates on the other.

### E. Small Phase 1 host-wiring follow-up

The production host adapter does not forward the optional selected-model argument added to `needsCompaction()` in Phase 1:

```text
direct module, foreign old-model measurement: false
same call through actual host adapter:       true
```

The module correctly rejects a foreign-model sample when given the target model. The adapter drops it, so the hosted threshold path still accepts that sample. This was not caught by the earlier presenter/module tests or review.

Source: `modules/sessions/host/agent-session-adapters.ts:297–298`.

Treat this as a small prerequisite patch with a regression at the host seam, not a reason to change the accounting design. It is recorded here rather than silently changed during exploration.

## 2. Recommended contracts

### Separate conversation and summary targets

- **Conversation target:** determines when compaction is needed, recent content to retain, and whether the rebuilt normal request fits.
- **Summary target:** determines invocability, credential/output-bound capabilities, summary input window, effective output maximum and summarization reasoning selection.

The current command carries one model and inherits its ThinkingLevel; that same selection drives settings and summary generation (`agent-session/maintenance-workflow.ts:144–184`). Explicit summary routing requires separating the roles, not simply replacing `command.model` everywhere.

Two constraints must be evaluated in the appropriate model's token units:

```text
estimated finalized summary input + summary output allowance + margin
    <= summary model context window

estimated rebuilt normal request + conversation response reserve
    <= conversation model context window
```

The second includes normal system/project/tool scaffolding and media projection, not just summary text. Keep the post-generation target-fit/reduction check: tokens generated by one model need not tokenize identically in another model.

The existing `requestOverheadTokens()` describes the **next normal Agent Turn**, including project instructions and tools (`host/agent-session-turn-runner.ts:342–370`). It is not the summary request's overhead. Count the summary system prompt, format instructions, escaped previous summary, escaped focus and escaped transcript independently.

### One finalized summary-request preparation seam

Have the provider-summary path prepare the actual system/messages and effective output limit before dispatch. Request rendering and estimation must share the same finalized value; do not build one string for estimation and another for sending.

Recommended output allowance is bounded by:

- explicit summary-output policy;
- selected summary model's output cap;
- room left after the final summary input and safety margin;
- the estimated space the eventual summary can occupy in the conversation target.

Apply the minimum viable summary check **after all clamps**. A model-specific maximum below the minimum must fail before network I/O, not produce a smaller request behind the planner's back.

The shared budget/acceptance policy must also cover injected `SummaryGenerator` adapters. A real provider generator must check its finalized provider request; a custom generator must not bypass known output/target limits merely by ignoring an optional input field. Keep post-generation checks in the compaction module even when dispatch is delegated.

No provider tokenizer/count-tokens facility was found in the searched SDK/shared utility surfaces. A heuristic plus margin is an estimate, not an exact no-overflow guarantee. Make that limitation explicit. An unknown summary context limit should produce an actionable budget-unavailable result in a safety-enforced path; do not silently substitute the conversation model's limit or infinity.

### Serializer: preserve structure, omit expendable material

- Omit reasoning blocks from summary input; this does not delete them from the stored Transcript.
- Retain message roles/IDs and tool name, Tool Call ID, terminal state and error/denial outcome outside truncated payload sections.
- Bound input/output body previews separately, with explicit omitted-byte markers; use head/tail where it preserves logs/error tails better than prefix-only output.
- Preserve attachment metadata-only behavior and untrusted-data/XML boundaries.
- Do not silently truncate the prior durable summary or user goals/constraints merely to get a request out.

Reuse `truncateUtf8()` and `keepTailUtf8()` from `modules/tools/output-bounds.ts`; do not add another UTF-8 truncator. If stronger shared behavior is needed, extend that module. Exact known tool path/argument extraction must reuse the coding-tool contracts rather than introduce parallel ad hoc parsers.

### Oversize behavior: fail safely before inventing chunking

After low-value reasoning/tool-body reduction, if the request still does not fit, return a non-benign, actionable budget error before provider dispatch. Preserve the existing Context and append no durable compaction entry. Attachment externalization may already have performed its existing storage work; this is not a claim of a database-wide rollback.

Do not treat an oversized summary request as benign `not-needed`, which could permit sending the same oversized conversation afterward. Guidance should name the failing target/limit and suggest an explicit larger summary model or reduced input.

Defer map/reduce/chunked summarization initially. It introduces multiple paid requests, intermediate-summary loss, cancellation and partial-result semantics; it needs its own explicit quality and atomic-commit contract.

## 3. Per-model compaction policy

Initial proposed configuration shape, implemented for exact-model reserve/recent budgets in Phase 2B:

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "openai/conversation-model": {
        "reserveTokens": 32768,
        "keepRecentTokens": 16000
      }
    },
    "summary": {
      "model": "anthropic/summary-model",
      "maxOutputTokens": 4096,
      "thinkingLevel": "off"
    }
  }
}
```

The ordinary budgets and exact `provider/modelId` overrides apply to the **conversation target**. Summary routing and its output/reasoning knobs are a separate object.

Recommended resolution:

```text
built-in scalar defaults
→ merged ordinary global/project values
→ matching exact-model override, field by field
→ existing session overrides, field by field
→ effective model-limit clamps
```

Global/project file layering occurs before exact-model lookup. Consequently a global model-specific value can beat a project-wide fallback; changing it in a project requires that project's matching model entry. Document this rather than inventing callsite-specific precedence.

- Match exact case-sensitive provider/model identities, preserving slashes in model IDs.
- Reuse `parseProviderModelSelection()` from `modules/providers/provider-model-selection.ts` and existing source/provenance utilities.
- Initially override only reserve/recent budgets; keep enabled/auto/recovery toggles ordinary, not per-model.
- Keep `modelOverrides`/`summary` out of the current scalar-key validator loop. `CompactionSettingKey` currently comes from scalar defaults and assumes boolean/positive-integer values (`compaction/config.ts:28–91,239–259`).
- Record both desired and clamped effective values, and the real winning nested config path/source.
- An invalid matching override must be diagnosed rather than silently dispatched under a replacement policy.
- Model/settings already admitted to an operation remain captured. Revalidate a joined compaction's settled Context against the waiting caller's conversation target before sending; changing retention policy invalidates the old assumption that model selection only affects summary generation.

The resolver currently does not receive the model identity at all, only its context limit (`compaction/settings-operations.ts:38–57`). Pass the exact conversation model into the central resolver; do not implement overrides in UI or Provider adapters.

## 4. Explicit summary-model routing and OAuth

Keep the SDK's output-bound capability guard. OpenAI OAuth requests with an explicit output maximum currently fail closed by design, defended by `test/sessions/summary-generator.test.ts` and the Provider SDK tests. Do not pretend that omitting the cap preserves the same safety contract.

Recommended route behavior:

1. With no configured summary model, use the conversation model and retain the existing capability checks.
2. With an explicit summary model, resolve that exact identity through the Host's existing selection/Plugin-owner checks and require it to be known, invocable and able to enforce the output bound.
3. If unavailable, unauthenticated, owner-mismatched or incapable, fail with guidance. No implicit provider substitution, credential switch or fallback model list.
4. Store the actual chosen summary selection in existing `summarizationModel` metadata; do not change the session/composer conversation model.
5. Resolve the summary ThinkingLevel independently. Prefer off when explicitly supported for a budget-focused summarizer, otherwise leave it unset unless configured; do not blindly inherit a chat `max` effort.

Routing to another provider changes both cost and where historical transcript data is sent. It must be an explicit trusted configuration choice, not an automatic workaround for OAuth.

The current SDK `ProviderChatFinish`/successful `ChatOutcome` do not expose a finish reason (`packages/ai/src/sdk.ts:266–292,503–511`). Therefore summary code cannot reliably distinguish output-limit truncation from ordinary success through the public event contract. Propagating finish reason is a separate SDK seam to evaluate if this phase promises rejection of provider-truncated handoffs. Do not claim that a nonempty response proves a complete handoff.

## 5. Suggested delivery order and pre-agreed test seams

### Prerequisite: fix host selected-model forwarding

Host-level regression: the actual adapter and direct module agree when the latest sample belongs to a different model. Preserve the optional selector argument end to end.

### 2A — Request and result safety first

Public seams: `serializeMessagesForCompaction()`, `createProviderSummaryGenerator()` with a scripted ProviderCollection, and `createSessionCompaction()` with persisted results observed through its store contract.

Contracts:

- Reasoning absent; tool ID/state/error survive bounded body reduction, independent of JSON property order.
- Final escaped prompt, prior summary, focus and system instructions all participate in the input estimate.
- Effective output below the minimum fails before dispatch, including model-limit clamps.
- Oversized input dispatches zero Provider requests and appends no compaction entry.
- The second compaction cannot grow the actual current Context, even when the Transcript is much larger.
- Post-generation conversation-target checks still reject an over-budget summary.
- Cancellation/provider/persistence failure never publishes a new compaction epoch or partial Context.

### 2B — Exact-model policies

Public seams: `resolveCompactionSettings()`/settings operations and Agent Session submission/maintenance.

Contracts: field-wise fallback and source paths, exact keys with slashes, model switches, invalid matching entries, small-window clamps, captured in-flight policy, and settled-context revalidation for a waiting different target. Manual/threshold/overflow paths resolve the same policy.

### 2C — Explicit summary target, if OAuth use is required now

Public seams: Host compaction adapter and actual ProviderCollection dispatch.

Contracts: chat target A versus summary target B retain independent budgets; only B receives the summary request; the composer stays A; B's identity is persisted; owner/auth/capability failure dispatches nothing; no hidden fallback; chat's threshold/retention never silently changes to B's policy.

Do not expand Phase 2 into mid-run compaction, deterministic cumulative file history, public compaction hooks or a per-request billing ledger.

## 6. Exploration validation (before implementation)

At exploration time, the unchanged product code passed:

```sh
bun test test/sessions/compaction.test.ts test/sessions/summary-generator.test.ts test/sessions/compaction-config.test.ts
# 51 pass, 0 fail
```

The disposable diagnostic intentionally reported the five reproduced gaps above.

## 7. Implemented scope

Phase 2A summary safety and the Phase 1 Host model-forwarding prerequisite were implemented first. Phase 2B exact-model policies are now implemented; explicit summary-model routing (2C) remains deferred.

Implemented contracts:

- Summary prompt preparation is a shared pure seam; the finalized escaped transcript, prior summary, focus, and system prompt all feed a character-based token estimate with a 256-token safety margin.
- The request output allowance is bounded by the summary model's context window and output maximum, plus the conversation model's retained-context room, actual Agent Turn request overhead, response reserve, and configured output maximum. The same immutable prepared prompt and estimate are reused at Provider dispatch.
- Unknown context-window limits and any effective planner budget below 256 fail before invoking a generator; a Provider Model output cap below 256 fails before Provider dispatch.
- Tool-call and tool-result metadata remain intact while input, output and error previews are independently bounded; reasoning is omitted only from summary serialization.
- Injected summary generators cannot persist nonempty output above the planned budget; repeated compaction acceptance compares fallback estimates for the current projected Context, not the un-compacted Transcript.
- The Host forwards the selected conversation model to threshold checks, preventing stale usage from another model from triggering compaction.
- `compaction.modelOverrides` resolves exact, case-sensitive `providerId/modelId` entries (including slash-containing model IDs) for `reserveTokens` and `keepRecentTokens`, after merged ordinary values and before session overrides. Model-limit clamps apply last.
- Desired and effective budgets retain the winning nested config paths and sources. Invalid matching budget values fall back field-by-field with diagnostics; malformed model identities and unsupported per-model fields—including unknown keys—are diagnosed and never applied.
- Manual, threshold, and overflow compaction resolve policy for their selected conversation model. Admitted compactions keep their resolved policy, while a waiting submission checks the settled Context against its own model policy before sending.

The implementation uses the existing `truncateUtf8()`/`keepTailUtf8()` helpers. Prompt/output token counts remain heuristics rather than tokenizer-exact guarantees.

## 8. Validation

- `bun run test`: 1,844 passed across 207 files, 0 failed.
- `bun run test:e2e`: 35 passed across 7 files, 0 failed.
- `bun check-types`, `bun check`, and `bun fix`: passed.
