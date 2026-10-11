# Prompt Caching

Wincode adds Anthropic's explicit prompt-cache breakpoints to supported Claude
models. The default Prompt Cache Retention Tier is `short` (Anthropic's default
5-minute lifetime). Configure model-specific overrides in the general
`settings.json` or `settings.jsonc` document:

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
`short`, `long`, or `off`. `long` selects Anthropic's documented 1-hour TTL.
Wincode sends cache controls only when the selected model's metadata declares
the requested explicit mode and retention tier; missing or unsupported
capabilities leave the request uncached. OpenCode Go routes through the
selected model's protocol, but a model with undocumented cache capabilities
remains uncached.

`off` removes Wincode-initiated cache controls. It is best-effort: it does not
disable provider-managed implicit caching on providers that apply it
independently. Prompt caching reuses processed prefixes but does not reduce
context-window usage or replace Session Compaction. One-off compaction-summary
requests bypass cache controls.

See [Anthropic prompt caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching)
for provider TTLs and cache behavior.
