# Phase 3: long-running Agent Turns

## Approved scope and seams

Add a generic context-preparation boundary between Model Steps, after completed tools and steering settlement. Coding-Agent owns compaction policy and publication. Never replay successful tools. The operator approved non-terminal model-step text checkpoints so compaction can safely summarize earlier steps of the same live turn and reopen does not lose their content.

TDD seams: Agent Runtime pre-request continuation, Session Host with scripted ProviderCollection dispatch, durable Session Store reopen. The follow-ups this foundation deferred are implemented in [Phase 3 follow-ups](./compaction-phase3-followups.md): expanded overflow recovery, cumulative file tracking, and bounded Plugin compaction hooks.

## Contracts

- Preparation runs only if another request is needed, never after a final text-only result or stop-turn tool batch.
- Tools settle and their checkpoints complete before preparation. A prepared request replaces context without rerunning model steps or tools; aggregate successful-turn billing remains unchanged.
- Preparation failure or cancellation ends the turn without another normal model request. No second terminal outcome; cancellation while summary generation or persistence is pending cannot publish a partial context. A successful durable write is the commit point: seal/rotate a committed checkpoint identity and reconcile a committed compaction before surfacing cancellation. Do not pretend a store write that already succeeded was rolled back.
- Steering consumed before preparation is retained exactly once; input committed while preparation is pending is polled again before dispatch. Queued input remains queued. Late, uncommitted Provider callbacks after interruption stay ignored; only a successfully committed terminal outcome may reconcile during cancellation settlement.
- A preparation callback receives the next request and the index where the newest settled assistant/tool/steering suffix begins. Coding-Agent preserves that raw suffix, including opaque provider continuation and whole tool batches.
- Earlier completed text is checkpointed as non-terminal content, not a fabricated successful turn and not a new billing entry. Terminal records contain only text not already checkpointed, with original turn-total usage.
- Compaction operates only on durable, canonical Session messages. The newest step/steering suffix is protected from the cut; older kept messages are rebuilt through the existing prompt conversion seam.
- Context publication stays with Agent Session. Compaction metadata remains reconstructible after reopen, latest measurements use the new compaction epoch, and the Transcript retains all durable tool/text effects.
- Summary target, budgets, owner/auth/capability checks remain those of Phase 2; no runtime-level coding-agent policy and no implicit fallback.

## Validation

- Focused validation: 28 core tests and 159 coding-agent tests pass.
- Final `bun run test`: 1,880 passed across 208 files, 0 failed.
- Final `bun run test:e2e`: 35 passed across 7 files, 0 failed.
- `bun check-types`, `bun check`, and `bun fix`: passed.
- Independent Standards review: no remaining documented violations or material smells after removing duplicated assistant-ID state.
- Independent Spec review: cancellation-during-write races were reproduced by Host regression tests and fixed by reconciling durable winners before surfacing cancellation. Active and interrupted-settling executions own their assistant identity in disjoint state.
- The first full Default run exposed an existing late-callback contract regression. Reconciliation was restricted to committed terminal outcomes; the targeted regression and persistence races pass, and both full portfolios were rerun successfully.
