# Prompt Caching

Wincode uses model-aware prompt caching through each selected Model Protocol. The
shared default retention tier is `short`; configure model-specific overrides in
the general `settings.json` or `settings.jsonc` document:

```json
{
  "promptCache": {
    "modelOverrides": {
      "anthropic/claude-opus-4-5": "long",
      "anthropic/claude-haiku-4-5": "off"
    }
  }
}
```

Overrides are keyed by `<connection-provider-id>/<model-id>` and accept
`short`, `long`, or `off`. Wincode sends a control only when the selected
model's metadata declares that control and its Model Protocol. Missing or
unsupported capabilities leave the corresponding option out of the request.
OpenCode Go is routed by the selected model's actual Model Protocol; it does not
inherit cache capabilities from its Connection Provider ID.

## OpenAI

For OpenAI GPT-5.6 and later models with declared Responses API capabilities,
Wincode uses a marked breakpoint after stable developer instructions, the
model-supported short `30m` cache lifetime, and a stable `prompt_cache_key` per
Session. The key is only a routing/accounting hint, not a security or isolation
boundary. OpenAI's documented minimum cacheable prefix is 1,024 visible input
tokens; OpenAI determines whether a request meets that eligibility threshold.
Models without matching metadata, including OpenCode Go routes whose cache
support is undocumented, receive no Wincode-added controls.

## Anthropic

Wincode adds explicit prompt-cache breakpoints to supported Claude models. The
default `short` tier uses Anthropic's default five-minute lifetime, while `long`
selects the documented one-hour TTL.

`off` removes Wincode-initiated cache directives, keys, retention options, and
breakpoints. It is best-effort: OpenAI and Gemini may still apply
provider-managed implicit caching, which Wincode cannot reliably disable. Prompt caching reuses provider-processed prefixes but does
not reduce context-window usage or replace Session Compaction. One-off
compaction-summary requests bypass cache controls.

See [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
and [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
for provider cache behavior and eligibility details.
