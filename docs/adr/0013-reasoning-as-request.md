# Reasoning is a request on the Model Target, not a Catalog record

A Model Catalog entry declares which reasoning levels a model supports. The
selected level is a transient property of one Model Target, carried as a plain
level identifier. No catalog record, session record, or message metadata ever
stores an expanded provider request.

Status: accepted

## Context

`ModelVariant` was a closed global enum of eight values
(`none`, `thinking`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) that
conflated four different things: an effort ladder, an on/off switch
(`thinking`), Anthropic's thinking mode (`adaptive` vs `budgetTokens`), and
Google's thinking level. Adding a provider or a level meant editing the enum,
a schema, and several resolver branches.

The three upstream projects all avoid that shape. Pi models reasoning as a
`Model` capability plus a `ModelThinkingLevel` request with an optional
`thinkingLevelMap`. OMP bakes an explicit `ThinkingConfig` per model at
generation time and routes the wire identifier by effort at request time.
OpenCode treats variants as named per-model request overrides with an open
`VariantID`.

## Decision

- The catalog entry owns a `ThinkingPolicy`: how the model expresses reasoning
  and which levels exist. Populated from models.dev `reasoning_options[]`,
  which carries `effort` (with `values`), `budget_tokens` (with `min`/`max`),
  and `toggle` — a model may carry more than one, and the combinations are
  meaningful (`toggle` + `budget_tokens` means "off, or on within a budget
  range"; `effort` + `budget_tokens` means "pick a level, the budget is a
  consequence").
- The Model Target carries the level. `resolveModelProviderOptions` translates
  that level into the provider's wire shape at the adapter boundary and nowhere
  earlier.
- Session rows and message metadata persist the level identifier only, as a
  lookup key into the catalog policy. They never persist the expanded request.

## Consequences

- The `variant` column, `variantRef`, and `sessionVariantRef` survive
  unchanged. ADR-0006's two-tier choice/effective split is not disturbed,
  because the persisted value is still a scalar identifier.
- Restoring an old session re-derives the wire request from the *current*
  policy. If a policy changed, the same persisted level can produce a
  different request than it did originally. This is accepted and must be
  visible in the ADR rather than discovered later.
- Retired levels are handled like retired models: the identifier resolves
  leniently for restore and strictly for send.
- A level that the model does not support is rejected at normalization, not in
  the provider resolver. The resolver keeps only the wire translation.

## Known defect closed by this decision

`anthropicManualModels` hard-coded `selectedBudget = 16_000` regardless of the
selected variant, so `high` and `max` produced byte-identical wire requests
while the picker offered them as two options. The `effort`/`budget_tokens`
range from models.dev replaces that table.
