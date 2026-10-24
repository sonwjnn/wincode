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

If that protected batch cannot fit, or checkpointing/summarization/persistence fails, the turn stops rather than dispatching an unsafe next request. Cancellation propagates to preparation. If a durable checkpoint or compaction write has already succeeded, its complete result is reconciled before cancellation settles; cancellation does not roll back committed storage. Aggregate billing stays on the terminal turn record; non-terminal text checkpoints do not add billed usage. Expanded overflow replay, cumulative file-operation tracking, and public compaction hooks are separate follow-ups.

## Summary policy

All three `summary` fields are optional:

- `model`: exact summary target. Omit it to use the conversation model; there is no automatic model fallback.
- `maxOutputTokens`: positive integer ceiling, further limited by the summary model's output/context limits and the conversation's room for the resulting summary. An effective budget below 256 tokens fails before dispatch.
- `thinkingLevel`: independently selected reasoning level. If omitted, compaction prefers `off` only when explicitly supported, otherwise leaves reasoning unset. It never inherits the chat's reasoning level. Explicit unsupported levels fail rather than being dropped.

The selected summary target must be known, authenticated/invocable, bound to its trusted Plugin owner where applicable, and able to enforce an output-token maximum. Invalid configuration or an unavailable/incapable target fails with guidance, without dispatching to a replacement model. In particular, OpenAI OAuth's output-bound limitation is not bypassed: use a supported credential or explicitly select a capable summary target.

**Selecting another Provider explicitly authorizes sending historical transcript data to that Provider and may change cost.** Summary routing never changes the Session/composer conversation selection or its threshold/retention policy. Compaction records store the actual summary model, Plugin owner binding when present, and effective thinking level.

Token estimates are heuristic, not tokenizer-exact. Oversized summary prompts fail before dispatch; compaction does not silently chunk or truncate the prior durable summary to fit. The SDK currently exposes no finish reason, so a nonempty response is not proof that the Provider completed it without output-limit truncation.
