# Phase 3 follow-ups: recovery, file tracking, hooks

## Scope

Completes the three capabilities deferred by [Phase 3](./compaction-phase3-exploration.md): overflow recovery that survives completed Tool Calls, cumulative file-operation metadata, and public Plugin compaction hooks.

## Contracts

- **Recovery preserves completed effects.** When the refused attempt already completed Tool Calls, recovery summarizes older durable history, protects the newest settled assistant/tool batch, drops the failed attempt's terminal row, and continues the compacted Session Context. The original prompt is not answered again and no successful tool is rerun. Without a completed tool batch the prompt-anchored recovery is unchanged. If no older history can be compacted while preserving the continuation, recovery fails closed with the compaction module's own guidance.
- **Continuation keeps retry accounting.** A context continuation may name the originating user message even after compaction summarized it away; the Session Message anchor requirement applies only when the message must be in the active Context.
- **File sets are deterministic.** They come only from completed built-in Read/Write/Edit output contracts, never from the model's prose. Directory and symlink reads report no File Version and are not observations; Shell, Glob and Grep declare no path. Cumulative sets carry across repeated compactions through the durable summary, are unioned before the cut so earlier spans are not lost, and are rendered as a host-owned `## Files` section. Each list is capped at 200 sorted paths.
- **Hooks are bounded by host authority.** A pre-compaction hook may cancel with a reason or supply handoff text; post hooks observe a committed entry or a safe failure. Hooks never receive transcript text, choose boundaries, set budgets, or persist entries. Custom summaries are validated against the same output budget and reduction/safe-threshold checks before persistence. A thrown hook is logged and cannot fail or roll back a compaction; a deliberate cancellation is not reported as a failure.

## Validation

- Focused: 223 tests across the Agent Session, Session Host, maintenance workflow, overflow recovery, compaction, Plugin and tool-file seams.
- Default portfolio: 1,910 passed across 212 files, 0 failed.
- E2E portfolio: 35 passed across 7 files, 0 failed.
- `bun check-types`, `bun check`, and `bun fix`: passed.

## Deliberate boundaries

- Recovery after tools needs older durable history; a turn whose only history is the prompt plus its first tool batch fails closed rather than splitting that batch.
- File tracking is per compaction entry, not a live session index; nothing reads it for UI yet.
- Hooks cover compaction only. Overflow recovery and between-step preparation reuse them, but they cannot observe the Model Step itself.
