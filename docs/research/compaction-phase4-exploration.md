# Phase 4 exploration: bounded, observable compaction

## Status and recommendation

Proposal only; no implementation scope is approved by this note. Baseline: `perf/compaction` at `111fe7b5`.

Phase 3 and its follow-ups are complete. Phase 4 should not remove their safety rules. Recommended order:

1. **4A — Preserve generation completion reasons and reject known-incomplete summaries.**
2. **4B — Add bounded sequential summarization for oversized historical input**, after completion fidelity and attempt-usage accounting are in place.
3. **4C — Expose structured compaction file snapshots**, without inventing a live file index.
4. **4D — Make unrecoverable continuation failures actionable**, without splitting or replaying the protected tool batch.

4C is independent of 4A/4B and may ship first for a smaller product slice. Expanded Plugin step observation is a separate optional feature. OAuth output enforcement and automatic model fallback are not prerequisites and should not be promised as Phase 4 deliverables.

## Evidence and corrections to the previous boundary list

This exploration uses the repository's own implementation as primary evidence. Links below identify modules and symbols, rather than relying on old line numbers. It does not assert new capabilities of external provider endpoints.

| Boundary | Current implementation | Phase 4 disposition |
| --- | --- | --- |
| No older history after completed tools | `prepareOverflowContinuationSource` preserves the newest settled batch; `chooseCheckpointCutPoint` refuses a cut with no older compactable span. | Keep the invariant; improve diagnostics and recovery choices. |
| File tracking is not a live index | `collectCumulativeFileOperations` unions declared Read/Write/Edit paths, sorts each set, and retains at most 200. | Add a structured snapshot view, not live indexing. |
| Hooks only observe compaction | Public hooks receive intent and outcome metadata, not transcript content or cut authority. | Keep this scope by default; separate observational step events only for a concrete consumer. |
| OAuth cannot enforce a summary output cap | OpenAI provider capability returns true only for API-key credentials; the OAuth request path rejects an explicit output maximum. | Keep refusal unless endpoint support is independently established. |
| No chunking; no finish-reason fidelity | One prepared summary request must fit; SDK terminal success does not convey generation stop reason. | 4A first, then bounded 4B. |
| No implicit fallback | Route captures one explicit target and its trusted Plugin owner. | Keep as a privacy/cost invariant. |

Two important corrections:

- **Files already have an indirect UI surface.** `CompactionDivider` expands `entry.summary.text`, which contains the host-owned `## Files` section. What is missing is structured presentation of `summary.fileOperations`, coverage/cap disclosure, and a clear snapshot-vs-current distinction—not all visibility.
- **Media budgeting is not absent.** `projectMessagesForEstimate` and attachment hydration already apply attachment count/byte/token limits, newest first. A future retained-media project must establish a concrete mismatch before adding another budget mechanism. It is not one of the six required follow-ups here.

Sources: [overflow recovery](../../packages/coding-agent/modules/sessions/compaction/overflow-recovery.ts), [cut selection and media projection](../../packages/coding-agent/modules/sessions/compaction/compaction.ts), [file sets](../../packages/coding-agent/modules/sessions/compaction/file-operations.ts), [divider](../../packages/coding-agent/modules/sessions/ui/components/compaction-divider.tsx), [attachment hydration](../../packages/coding-agent/modules/sessions/storage/attachment-store.ts), [Plugin contracts](../../packages/coding-agent/modules/plugins/public.ts), [OpenAI provider](../../packages/ai/src/sdk-providers/openai.ts), [summary route](../../packages/coding-agent/modules/sessions/host/compaction-summary-route.ts).

## Non-negotiable contracts

- Completed effects are never replayed to reconstruct context. Opaque continuation and the newest settled assistant/tool/steering suffix remain authoritative.
- Host owns cut selection, budgets, target authorization, persistence, and publication. Plugin decisions do not acquire transcript access or storage authority.
- Cancellation does not undo a successful durable write. After a committed compaction, reconcile its result before surfacing cancellation.
- No partial chunk becomes a durable Session compaction or replaces active context. One logical compaction has one final entry and one lifecycle outcome.
- Provider usage is billing information, not the current context measurement. New compaction epochs invalidate prior context measurements as before.
- A different summary Provider is a disclosure/cost decision, not a transparent availability fallback.

## 4A — Generation completion fidelity

### Why first

`ProviderChatFinish` carries continuation but no stop reason. `ProviderCollection` folds the finish into `ChatOutcome.status = "success"`. `collectProviderSummary` rejects transport/provider failures and aborts, but a nonempty output otherwise becomes a candidate handoff.

The OpenAI Responses parser treats both `response.completed` and `response.incomplete` as a completed stream and does not forward `incomplete_details`. OpenAI Chat and Google likewise recognize finish fields without exposing their semantic reason at the public consumer seam. **A cleanly terminated transport is not proof of a completed handoff.** More summary requests in 4B would multiply this ambiguity.

Sources: [SDK finish/outcome and stream folding](../../packages/ai/src/sdk.ts), [Responses parser](../../packages/ai/src/sdk-private/protocols/openai-responses.ts), [Chat parser](../../packages/ai/src/sdk-private/protocols/openai-chat.ts), [Google parser](../../packages/ai/src/sdk-private/protocols/google.ts), [Anthropic parser](../../packages/ai/src/sdk-private/protocols/anthropic.ts), [summary collector](../../packages/coding-agent/modules/sessions/compaction/summary-generator.ts).

### Proposed seam

Carry normalized generation-completion metadata through the existing protocol → Provider finish → SDK terminal path. Keep transport status separate from generation completion; do not globally turn ordinary output-limited Agent Turns into provider failures.

The normalized vocabulary should distinguish completed generation, output-limit termination, filtering/refusal, and unknown termination. Preserve provider evidence where useful for diagnostics, without leaking raw provider payloads into Plugin hooks. Map each built-in protocol explicitly; do not guess a provider's stop reason from output length or token usage.

The summary consumer must reject known truncation/filtering as `summary-failed`, before persistence. Proposed policy for unknown reasons: refuse a generated handoff with actionable guidance unless that adapter has an explicit, tested completion guarantee. This policy needs approval because custom provider adapters currently need not expose a reason. Do not silently equate unknown with completed.

Plugin handoffs stay on their existing host validation path; they are not provider generations and should not require synthetic provider finish evidence.

### Contract-first tests

- Nonempty text followed by output-limit termination is not persisted as a compaction.
- Responses `response.incomplete` cannot masquerade as generation completed; a prematurely disconnected stream is still a distinct transport failure.
- Completed summary text with a supported completion reason reaches normal reduction and threshold checks.
- Refusal/filtering does not become an empty-success or partial-success handoff.
- Missing completion evidence follows the approved unknown policy, including custom providers.
- Ordinary tool continuation, output-limited Agent Turn behavior, opaque continuation and billing remain unchanged by the added metadata.
- Abort/failure after text deltas publishes neither partial context nor a compaction-completed hook.

## 4B — Bounded sequential summaries for oversized history

### Actual gap

`prepareSummaryRequest` builds one escaped prompt containing focus, the complete prior summary, and serialized new history. `resolveSummaryOutputBudget` and the generator check that complete request against summary-model and conversation budgets. If it does not fit, compaction refuses; it does not plan multiple requests.

Existing tool-result serialization is already bounded. Do not duplicate that serializer or attempt to solve a long user message by adding a second arbitrary tool-output truncator.

Sources: [prompt construction](../../packages/coding-agent/modules/sessions/compaction/summary-prompt.ts), [serialization, budget, persistence](../../packages/coding-agent/modules/sessions/compaction/compaction.ts), [generator](../../packages/coding-agent/modules/sessions/compaction/summary-generator.ts).

### Design alternatives

| Design | Advantage | Cost / reason not to start here |
| --- | --- | --- |
| Reject oversized history (today) | Simple and fail-closed | Cannot compact otherwise valid large history into a smaller summary model. |
| Sequential rolling handoff | Chronological precedence, one accumulator, bounded concurrency | Multiple requests; compression error can accumulate. **Recommended first extension.** |
| Parallel map/reduce | Potentially lower latency | Merge ambiguity, concurrent spend, more cancellation/accounting complexity. Defer. |

### Proposed deep module

Keep chunk planning/execution inside the compaction summarization module, behind one logical summarize-history interface. Host captures one authorized target, policy and signal for the entire operation. Agent Runtime should not learn chunking policy.

1. Host chooses the durable summary span and protected suffix exactly as today.
2. Convert the summary span into ordered serialization units retaining message IDs, roles and tool-call/result association. Reuse the canonical serializer; do not split the escaped final prompt by character offsets.
3. Plan the next request against the **fully prepared prompt**, including system text, focus, current accumulator, escaping, output allocation and safety margin.
4. Process units sequentially. The first request incorporates the prior durable handoff; later requests update its in-memory replacement with newer evidence. Do not resend the original prior summary as an additional competing authority on every iteration.
5. Check completion evidence and enforce each output budget. No truncating the prior summary to create prompt room.
6. Validate the final rebuilt context, append one compaction entry, then publish once. Collect file/attachment metadata from the original covered span, not from intermediate model prose.

**First version should not split an indivisible oversized unit.** A single huge message, protected batch, or prior handoff that cannot fit with the required scaffolding still gets a precise refusal. Arbitrary fragmenting is a separate design problem; chunking does not guarantee every overflow can be recovered.

Use an explicit maximum request count and total output-token allocation (a hard cost ceiling only where provider limits and the price model support it). Stop before the next request would exceed either. Keep concurrency at one. Input spend also grows when the accumulator is repeatedly sent, so an output cap alone is not a complete spend policy. Freeze policy at the start; settings changes must not retarget an in-flight chain.

No unbounded retries, nested compactions, automatic larger-model selection, or durable intermediate summaries in this slice. Crash recovery restarts a new logical operation; it does not resume a half-persisted chain.

### Accounting is a prerequisite, not cleanup

Today a successful compaction stores one `summarizationUsage`; the separate `SessionUsageEntry.kind` supports only `cache-warm`. A multi-request chain may incur usage before a later request fails, is aborted, or cannot be persisted.

Before enabling 4B, choose one authoritative usage ledger for compaction generation attempts, including usage received from failed/cancelled chains. Give attempts stable identities and avoid counting both ledger entries and the final compaction aggregate in Session totals. Reuse/extend the existing usage-entry module rather than adding an unrelated billing store. If a provider never supplies usage, report unknown rather than fabricating billed tokens. Persistence/usage-reporting races need explicit tests; no system can recover exact provider billing from missing telemetry alone.

Sources: [compaction usage shape](../../packages/coding-agent/modules/sessions/compaction/types.ts), [Session usage-entry contract](../../packages/coding-agent/modules/sessions/storage/session-store.ts), [Session usage aggregation](../../packages/coding-agent/modules/sessions/usage/session-usage.ts).

### Contract-first tests

- A history exceeding a smaller summary window compacts through multiple requests; every final prepared request fits its own budget.
- The ordinary fitting-history path still uses exactly one generation.
- An indivisible unit or complete prior summary that cannot fit fails without dispatching an oversized request or dropping content silently.
- Newer evidence replaces conflicting older state; pending requests and required constraints survive the sequential handoff.
- Tool associations, IDs, deterministic file sets and attachment metadata survive independently of intermediate prose.
- Request/output allowances halt further generation deterministically; usage already received is counted once even if the chain fails.
- Failure/cancellation at each request or final write leaves no partial active context. A successful durable final write is reconciled normally.
- Manual/threshold/overflow/between-step paths share the module; protected tool effects execute exactly once.
- Hooks observe one logical before/completed/failed sequence, not one lifecycle per chunk; a Plugin summary dispatches zero chunks.
- Reopen reconstructs only the final committed context and preserves accounting without reusing stale context measurements.

## 4C — Structured file snapshots, not a live workspace index

### Recommended small product slice

Extend the existing compaction detail presentation to render the persisted `summary.fileOperations` directly. Label it **tracked files through this compaction**, not "currently modified files" or Git status. Keep Read and Modified separate; a path may correctly appear in both.

Use Session compaction state already loaded by Agent Session. No filesystem scan, Git command, transcript-prose parser, new index, or new database table is needed for the basic view. Existing text rendering remains the fallback for entries without structured metadata. Do not display the same Files block twice when presenting structured metadata.

The 200-path cap matters: sorted-set truncation is not a lossless historical file index. A newer lexicographically earlier path can displace a previously retained path. Label the view as bounded; do not invent an exact total from capped arrays. If precise cap disclosure is needed, persist explicit coverage/truncation metadata as a separate small contract change. Do not infer unobserved paths from model text or Shell output.

Sources: [file collection and cap](../../packages/coding-agent/modules/sessions/compaction/file-operations.ts), [tool output extraction](../../packages/coding-agent/modules/tools/file-operations.ts), [Agent Session compaction state](../../packages/coding-agent/modules/sessions/agent-session/agent-session.ts), [divider](../../packages/coding-agent/modules/sessions/ui/components/compaction-divider.tsx).

### Contract-first tests

- Expanding the divider shows the persisted snapshot, not a recomputed current workspace state.
- Repeated compaction/reopen keeps deterministic sets; read-and-modified membership is visible in both groups.
- Empty metadata does not imply that no files changed; no model-prose extraction fills it in.
- Over-cap data is disclosed as bounded; the UI never claims completeness or an unknown exact total.
- Long paths and keyboard access work in the terminal layout; viewing a snapshot performs no file operation.

## 4D — Actionable continuation refusal

Do not make the "first tool batch only" case succeed by loosening the cut. The remaining raw batch may itself exceed the provider window; summarizing or replaying it would violate the current continuation contract.

Instead, surface a distinct actionable reason for no older history versus a retained context that is still too large. Explain that completed effects remain on disk/in the Transcript. Offer only explicit actions the Host can actually support, such as selecting a larger-context conversation model or starting a new handoff session. Do not claim changing only the summary model will make an oversized protected suffix fit.

Starting a new session must be an explicit user decision: it is not continuation of the old opaque provider state and must not automatically execute the original prompt. An eventual tool-result reference/projection design needs its own contracts and durable provenance; it is not a small cut-selection tweak.

Sources: [protected cut](../../packages/coding-agent/modules/sessions/compaction/compaction.ts), [recovery source](../../packages/coding-agent/modules/sessions/compaction/overflow-recovery.ts), [maintenance workflow](../../packages/coding-agent/modules/sessions/agent-session/maintenance-workflow.ts).

Acceptance: first-batch refusal leaves tool counters and durable side effects unchanged; guidance distinguishes insufficient older history from an oversized retained suffix; cancellation, steering and reopen behavior do not regress.

## Optional / gated work

### Plugin Model Step observation

There is already a generic `model-step-started` runtime event and an existing Session presentation event path. If a concrete Plugin needs latency/usage monitoring, adapt existing runtime events into a narrow read-only observation contract rather than adding another context-preparation hook.

Candidate fields: Session/turn/step identity, model identity, timing, normalized usage and outcome. Exclude prompts, reasoning, raw continuation and tool payloads. Disabled Plugins receive no observations. Observers cannot delay dispatch, veto turns or rewrite context; bound queues and isolate failures. This changes ordering/backpressure/privacy semantics and should be a separate proposal, not bundled into compaction hooks.

Sources: [runtime events](../../packages/agent-core/src/events.ts), [Agent Runtime](../../packages/agent-core/src/agent-runtime.ts), [Session runtime-event handling](../../packages/coding-agent/modules/sessions/hooks/runtime-turn.ts), [Plugin public surface](../../packages/coding-agent/modules/plugins/public.ts).

### OAuth-generated summaries

Completion reasons from 4A do **not** create an enforceable maximum output budget. Cancelling after receiving enough text limits local consumption, not necessarily server generation or billed output. Chunking input does not solve this either.

Keep the current capability check until primary endpoint evidence and request-contract tests establish a hard output-limit mechanism for the actual OAuth endpoint. No such new evidence was gathered here. Continue offering an explicitly configured capable summary target or Plugin handoff. Do not change generated model files, pretend OAuth is an API key, or use an unbounded request as a fallback.

Sources: [OpenAI authorization/request behavior](../../packages/ai/src/sdk-providers/openai.ts), [Responses serialization](../../packages/ai/src/sdk-private/protocols/openai-responses.ts), [summary capability](../../packages/coding-agent/modules/sessions/compaction/summary-generator.ts).

### Explicit fallback policy

Retain the single-target rule in Phase 4. A future ordered fallback policy would require explicit authorization of each Provider/model, captured Plugin ownership and capabilities, bounded attempts, actual target provenance, and accounting for failed attempts. Authentication/configuration errors should remain visible, not silently redirect historical transcript data. This is a new product policy, not error-handling cleanup.

## Delivery gates and validation

| Slice | Dependencies | Suggested TDD seam | Exit evidence |
| --- | --- | --- | --- |
| 4A | Agreement on unknown completion policy | Protocol adapters → SDK terminal → summary collector | Completion mapping fixtures for built-ins; incomplete summary never persisted; ordinary runtime unaffected. |
| 4B | 4A, approved request/spend limits, attempt-usage ledger | Compaction planner/generator, Session Host, durable Store reopen | Bounded fitting requests; semantic handoff fixtures; one final commit; accounting and cancellation tests. |
| 4C | Snapshot labeling and cap-disclosure decision | Existing divider/Session UI + persisted compaction fixtures | Keyboard-accessible bounded snapshot, no scans, no duplicate Files section. |
| 4D | Approved user actions | Maintenance error mapping + Host/UI | Clear refusal with side effects preserved; no automatic replay/reset. |

Run `bun fix`, `bun check`, `bun check-types`, focused contract tests, then full Default/E2E portfolios after implementation. Obtain independent Standards and Spec reviews before committing code.

Interactive validation should cover both manual and real threshold compaction, plus a generated-summary run on a capable credential to exercise 4A/4B. The Phase 3 OAuth smoke used a **constant Plugin handoff**: it proves dispatch/commit/context plumbing, not summary completeness, semantic fidelity, or chunking. Capture hook triggers, committed entries and reconstructed context, and verify execution counters/side-effect hashes—not just unique tool-call IDs—to defend against replay with fresh IDs.

Tokenizer estimates remain heuristic. The smoke's random-text prompt produced roughly 748K observed input tokens from 1.6 MB, so chars/4 is not a universal upper bound. Chunking must preserve provider overflow handling and bounded failure; do not claim estimator-fit proves provider-fit. Calibrated/provider-specific estimation is a separate capability to evaluate if fixtures demonstrate repeated avoidable refusals.

## Decisions needed before implementation

1. Approve 4A first, including the treatment of unknown finish reasons/custom providers.
2. Choose whether 4B is required now or follows the independent smaller 4C slice.
3. For 4B, approve explicit request/output/input-spend controls and accounting of failed attempts; no unbounded automatic retries.
4. For 4C, choose a snapshot-only view (recommended) versus a separately scoped live session file index.
5. Keep protected-batch safety, Plugin transcript isolation, OAuth output-cap refusal, and no implicit fallback unchanged.

No implementation or full test-suite run was performed for this exploration. Only this proposal document was added.
