# Provider-aware prompt caching stays separate from Session Context

Provider prompt caching reuses provider-side processing of a matching prefix; it does not shorten the model's context, which remains the concern of Session Compaction. This ADR records the accepted target architecture for Anthropic, OpenAI, Google, and OpenCode Go; implementation is pending.

Status: accepted

## Decision

- **Model Protocol owns cache semantics.** Model metadata declares each model's supported cache modes, retention tiers, and any relevant eligibility limits. The Model Protocol serializes cache controls and normalizes provider usage. OpenCode Go follows the selected model's actual Model Protocol, not the connection-provider ID.
- **Policy is model-aware.** Use a global short-retention default with per-model overrides, constrained by declared capability. `off` disables cache directives, explicit resources, keys/retention controls, and warming that Wincode initiates. It is best-effort: OpenAI and Gemini may still apply provider-managed implicit caching, which Wincode cannot reliably disable. An OpenAI `prompt_cache_key` is a routing/accounting hint, not a security boundary.
- **Provider-specific behavior remains distinct.** Anthropic uses explicit `cache_control` breakpoints on stable prefixes. OpenAI uses only the controls and retention values supported by the selected model; where supported, `prompt_cache_key` is stable per Session. Google has a separate `CachedContent` resource manager for explicit caching: cache stable system instructions and tool schemas, not changing conversation history; key resources by Session, Model Target, and cacheable-prefix fingerprint; apply the selected TTL and delete on prefix change or session close. TTL is the crash-cleanup fallback. Google implicit caching is observed through usage, not controlled by Wincode. Google resources are not synthetically warmed or automatically extended.
- **Warming is streaming-only and economic.** For a route whose cache lifetime can be refreshed by a model request, refresh only while its Stateful Agent remains active and the request can be replayed with the same prompt-affecting options. Schedule near 90% of TTL while keeping a 10-second margin; stop after one hour from the real request. Warm only when known pricing predicts at least $0.05 in savings; use at most one output token, no retries, and one warmer per Session. Stop on context/Model Target change or when the agent settles. Warming and resource failures never fail the active Agent Turn. Compaction-summary requests do not use cache controls or warming.
- **Usage is canonical and separate from conversation.** `ModelUsage.inputTokens` means total input tokens, including cached reads and writes; `cacheReadTokens` and `cacheWriteTokens` are breakdowns within that total. Anthropic's `input_tokens` must therefore be normalized together with its cache-read and cache-creation fields; OpenAI and Google totals are preserved according to their protocol contracts. Cost calculation prices the uncached, cached-read, and cache-write portions separately, while context and compaction use the full input total. Persist warm spend as a separate Session Usage Entry, not a Session Record or message; include it in Session cost/UI, but never in Session Context or Session Transcript.
- **Cache failure is an optimization failure.** For a cache-specific rejection before any output, retry once without cache controls or the explicit resource. Do not retry unrelated provider errors or errors after output begins.

## Consequences

The model metadata type, schema, and generator/overlays must carry cache capabilities; generated metadata remains generated and is not edited directly. Session persistence and SessionUsage need a distinct usage-entry path, and the session surface needs cached read/write and warming information. Database schema changes follow the repository's direct Drizzle synchronization policy. Contract tests must protect total-context accounting, provider-specific request serialization and routing, cache-specific fallback, Google resource cleanup, summary-request opt-out, and the rule that warming usage affects cost but not conversation context.

## Sources

- [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Gemini context caching](https://ai.google.dev/gemini-api/docs/caching)
- [Gemini CachedContent API](https://ai.google.dev/api/caching)
