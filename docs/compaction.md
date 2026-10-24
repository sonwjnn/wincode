# Compaction configuration

Configure compaction in global or project `.wincode/settings.json` (or `.jsonc`).

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "openai/gpt-5.6": {
        "reserveTokens": 24000
      }
    },
    "summary": {
      "model": "openai/gpt-5.6",
      "maxOutputTokens": 4096,
      "thinkingLevel": "off"
    }
  }
}
```

Use exact, case-sensitive `providerId/modelId` identities from your configured Providers; slashes inside the model ID are preserved. The example does not install a model or authorize a Provider.

## Conversation policy

`contextWindowTokens` is an optional explicit settings override for every Provider Model, including the conversation and summary targets. When it is unset, Wincode uses the selected model's declared context-window metadata; if that metadata is missing or invalid, the fallback is **272,000** tokens. Set a positive safe integer in global or project `.wincode/settings.jsonc` to override model metadata. Project configuration takes precedence over global configuration. An explicit override that exceeds a Provider's actual limit may be rejected, so choose a value suitable for the models you use.

`reserveTokens` and `keepRecentTokens` govern the conversation target, not the summary target. Resolution uses built-in defaults, merged ordinary global/project values, the matching model override per field, session overrides, then clamps against the conversation model's effective context window (override, metadata, or fallback). File layering happens before model lookup, so a global model-specific setting can beat a project-wide fallback.

Only reserve/recent budgets support model overrides. Invalid values and unsupported fields are diagnosed.

Threshold checks use the selected model's resolved compaction threshold and the latest valid context measurement in the current compaction epoch, even when another conversation model produced that measurement. Messages after that observation are estimated. Switching models does not compact immediately; the selected model's threshold is checked before its next request. The usage bar uses the selected model's effective context window (explicit override, model metadata, or fallback) and estimates context instead of presenting a different model's measurement as exact.

## Long-running turns

When automatic compaction is enabled, the Host also checks context before a subsequent Model Step, after tools have settled. It checkpoints completed text without declaring the turn finished, and compacts older durable history when needed. The newest assistant/tool batch and delivered steering remain intact, including opaque Provider continuation. Successful tools are never rerun to rebuild context.

With `overflowRecovery` enabled, a successful Provider response that reports input usage above the selected model's effective context window also triggers compaction, even when automatic threshold compaction is disabled. For a continuing turn, this runs after its tool calls settle and resumes from the preserved assistant/tool batch. This uses Provider-reported input usage, not the estimated usage bar.

If that protected batch cannot fit, or checkpointing/summarization/persistence fails, the turn stops rather than dispatching an unsafe next request. Cancellation propagates to preparation. If a durable checkpoint or compaction write has already succeeded, its complete result is reconciled before cancellation settles; cancellation does not roll back committed storage. Aggregate billing stays on the terminal turn record; non-terminal text checkpoints do not add billed usage.

## Overflow recovery after completed tools

Recovery keeps completed side effects. When the refused attempt already completed Tool Calls, recovery no longer replays the original prompt: it summarizes older durable history, protects the newest settled assistant/tool batch, and continues the compacted Session Context from that batch. The failed attempt's terminal row is dropped from that source. If no older history can be compacted while preserving the continuation, recovery fails closed instead of rerunning a tool. Without completed tools, the earlier prompt-anchored recovery applies unchanged.

## Cumulative file operations

Each automatic or manual compaction records the files its completed built-in Tool Calls read and modified, derived only from the declared Read/Write/Edit output contracts. Compaction entries carry the cumulative sets across repeated compactions, and the handoff text ends with a host-owned `## Files` section listing them. A Read that reports no File Version (a directory or symlink) is not a file observation; Shell, Glob and Grep declare no deterministic path and contribute nothing. Each list is capped at 200 deterministic paths.

The compaction divider exposes these persisted sets as separate **Read** and **Modified** groups when expanded with a click or Enter/Space. It removes only the exact host-owned `## Files` suffix from the prose view, so the structured snapshot is not shown twice. The UI discloses the 200-path-per-group bound and that this is a snapshot of completed tool outputs through the compaction, not a scan of or claim about the current workspace. The displayed paths may appear in both groups.

## Plugin compaction hooks

Plugins may register `onBeforeCompaction`, `onCompactionCompleted`, and `onCompactionFailed`. The pre-compaction hook may cancel with a reason or supply handoff text instead of a summary model; the post hooks observe a committed entry identifier and token counts, or a safe failure message. Plugins never receive transcript text, choose a cut boundary, change a budget, or write an entry. A custom summary still passes host validation: empty text or text above the effective output-token budget fails before persistence, and the ordinary reduction and safe-threshold checks still apply.

## Summary policy

All three `summary` fields are optional:

- `model`: exact summary target. Omit it to use the conversation model; there is no automatic model fallback.
- `maxOutputTokens`: positive integer ceiling, further limited by the summary model's output-token limit and its effective context window (explicit override, model metadata, or fallback). An effective budget below 256 tokens fails before dispatch.
- `thinkingLevel`: independently selected reasoning level. If omitted, compaction prefers `off` only when explicitly supported, otherwise leaves reasoning unset. It never inherits the chat's reasoning level. Explicit unsupported levels fail rather than being dropped.

The selected summary target must be known, authenticated/invocable, bound to its trusted Plugin owner where applicable, and able to enforce an output-token maximum. Invalid configuration or an unknown/unauthenticated target fails with guidance, without dispatching to a replacement model. The output-token-enforcement check alone is deferred when a Plugin supplies the handoff through `onBeforeCompaction`: a Plugin summary generates nothing, so it compacts even when the conversation credential cannot enforce an output cap. Without a Plugin summary that same guidance fails before any generation. OpenAI OAuth's output-bound limitation is therefore not bypassed for a generated summary: use a supported credential, explicitly select a capable summary target, or supply the handoff from a Plugin.

**Selecting another Provider explicitly authorizes sending historical transcript data to that Provider and may change cost.** Summary routing never changes the Session/composer conversation selection or its threshold/retention policy. Compaction records store the actual summary model, Plugin owner binding when present, and effective thinking level.

Token estimates are heuristic, not tokenizer-exact. When the full historical span does not fit one request, compaction sequentially summarizes complete historical units and carries each completed handoff into the next request. One chain is limited to four Provider requests, 32,000 aggregate output tokens, and 128,000 aggregate estimated input tokens; actual reported input usage is checked against the same chain limit. The chain has no retries or durable intermediate compactions: if it cannot cover all eligible history within those budgets, any attempt fails, or any attempt lacks completion evidence, no compaction entry is committed. Reported usage from completed and failed attempts remains in the durable Session usage ledger and is charged per request. The prior durable summary is not truncated to fit. Provider completion evidence is carried to the summary generator: only `completed` output is accepted. Output-limit, filtering, other known-incomplete, and unknown completion all fail before persistence, even if text was emitted. Missing completion evidence from a custom Provider is normalized to `unknown`. Agent Turns retain their ordinary successful terminal status; this stricter check applies to model-generated compaction summaries.

## Overflow recovery failure guidance

Recovery distinguishes failures before and after the compaction commit. If recovery cannot prepare or persist a compaction, the existing Session remains un-compacted and no continuation starts. If compaction commits but continuation fails or is refused, the saved compacted Context remains available. The UI tells the user which state was reached and advises reviewing the existing Session and completed tool results before continuing. Recovery never creates a new Session or replays completed tool effects; do not resubmit the original request blindly after a continuation failure.
