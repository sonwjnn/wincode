# Unified ThinkingLevel

Wincode exposes one normalized `ThinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) across model selection, configuration, session persistence, plugins, delegation, RPC, and CLI surfaces. Per-model metadata maps supported levels to provider-native request values; that translation remains below the shared contract. An omitted level preserves the provider default, prompt configuration selects `low` when supported, explicit `off` remains available where supported, toggle-only models map positive levels to enabled reasoning, and budget-only models stay automatic without a selector. The Session schema does not translate prior Effort/Reasoning Mode values; incompatible local Session data is reset while prompt history is preserved.

Status: accepted

## Consequences

- `ThinkingLevel` replaces Wincode-owned `Effort` and `ReasoningMode` selection contracts; provider-native `effort` fields remain inside provider adapters and metadata ingestion.
- `xhigh` and `max` are selectable only when a model's metadata explicitly supports them. Unsupported levels are rejected or cleared at the domain boundary, not silently mapped by provider adapters.
- The user-facing selector and `--thinking-level` option expose the same levels. Budget-only reasoning models do not offer a selector because the provider chooses the budget automatically.
- This decision supersedes ADR-0033's separate Effort and Reasoning Mode selection model.
