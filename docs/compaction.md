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

`reserveTokens` and `keepRecentTokens` govern the conversation target, not the summary target. Resolution uses built-in defaults, merged ordinary global/project values, the matching model override per field, session overrides, then the conversation model's context-window clamps. File layering happens before model lookup, so a global model-specific setting can beat a project-wide fallback.

Only reserve/recent budgets support model overrides. Invalid values and unsupported fields are diagnosed.

## Long-running turns

When automatic compaction is enabled, the Host also checks context before a subsequent Model Step, after tools have settled. It checkpoints completed text without declaring the turn finished, and compacts older durable history when needed. The newest assistant/tool batch and delivered steering remain intact, including opaque Provider continuation. Successful tools are never rerun to rebuild context.

If that protected batch cannot fit, or checkpointing/summarization/persistence fails, the turn stops rather than dispatching an unsafe next request. Cancellation propagates to preparation. If a durable checkpoint or compaction write has already succeeded, its complete result is reconciled before cancellation settles; cancellation does not roll back committed storage. Aggregate billing stays on the terminal turn record; non-terminal text checkpoints do not add billed usage.

## Overflow recovery after completed tools

Recovery keeps completed side effects. When the refused attempt already completed Tool Calls, recovery no longer replays the original prompt: it summarizes older durable history, protects the newest settled assistant/tool batch, and continues the compacted Session Context from that batch. The failed attempt's terminal row is dropped from that source. If no older history can be compacted while preserving the continuation, recovery fails closed instead of rerunning a tool. Without completed tools, the earlier prompt-anchored recovery applies unchanged.

## Cumulative file operations

Each automatic or manual compaction records the files its completed built-in Tool Calls read and modified, derived only from the declared Read/Write/Edit output contracts. Compaction entries carry the cumulative sets across repeated compactions, and the handoff text ends with a host-owned `## Files` section listing them. A Read that reports no File Version (a directory or symlink) is not a file observation; Shell, Glob and Grep declare no deterministic path and contribute nothing. Each list is capped at 200 deterministic paths.

## Plugin compaction hooks

Plugins may register `onBeforeCompaction`, `onCompactionCompleted`, and `onCompactionFailed`. The pre-compaction hook may cancel with a reason or supply handoff text instead of a summary model; the post hooks observe a committed entry identifier and token counts, or a safe failure message. Plugins never receive transcript text, choose a cut boundary, change a budget, or write an entry. A custom summary still passes host validation: empty text or text above the effective output-token budget fails before persistence, and the ordinary reduction and safe-threshold checks still apply.

## Summary policy

All three `summary` fields are optional:

- `model`: exact summary target. Omit it to use the conversation model; there is no automatic model fallback.
- `maxOutputTokens`: positive integer ceiling, further limited by the summary model's output/context limits and the conversation's room for the resulting summary. An effective budget below 256 tokens fails before dispatch.
- `thinkingLevel`: independently selected reasoning level. If omitted, compaction prefers `off` only when explicitly supported, otherwise leaves reasoning unset. It never inherits the chat's reasoning level. Explicit unsupported levels fail rather than being dropped.

The selected summary target must be known, authenticated/invocable, bound to its trusted Plugin owner where applicable, and able to enforce an output-token maximum. Invalid configuration or an unknown/unauthenticated target fails with guidance, without dispatching to a replacement model. The output-token-enforcement check alone is deferred when a Plugin supplies the handoff through `onBeforeCompaction`: a Plugin summary generates nothing, so it compacts even when the conversation credential cannot enforce an output cap. Without a Plugin summary that same guidance fails before any generation. OpenAI OAuth's output-bound limitation is therefore not bypassed for a generated summary: use a supported credential, explicitly select a capable summary target, or supply the handoff from a Plugin.

**Selecting another Provider explicitly authorizes sending historical transcript data to that Provider and may change cost.** Summary routing never changes the Session/composer conversation selection or its threshold/retention policy. Compaction records store the actual summary model, Plugin owner binding when present, and effective thinking level.

Token estimates are heuristic, not tokenizer-exact. Oversized summary prompts fail before dispatch; compaction does not silently chunk or truncate the prior durable summary to fit. The SDK currently exposes no finish reason, so a nonempty response is not proof that the Provider completed it without output-limit truncation.
