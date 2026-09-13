# Model metadata is generated once, from one source, with provenance

One script, `scripts/sync-model-metadata.ts`, fetches models.dev and emits one
generated file holding reasoning policy, cost, and limits for the whole
catalog. Generated output and manual overlays are both first-class sources; the
script records which entries used which, and reports entries that upstream no
longer serves instead of inventing a baseline for them.

Status: accepted

## Context

`scripts/sync-model-pricing.ts` was deleted in `49548ee` (remove hosted cloud
product surface), but the two files it produced are still imported at runtime:
`packages/ai/src/generated/model-variants.generated.ts` by `models.ts` and
`model-provider-options.ts`, and
`packages/tui/modules/model-pricing/model-pricing-snapshot.generated.ts` by
`model-pricing-provider.tsx`. Both carry a `2026-08-08` header naming a script
that no longer exists. They cannot be regenerated.

The two files also drifted by construction. Variants and pricing were generated
separately and refreshed on different rhythms, so the UI could resolve a
variant from one revision and a price from another. The
`anthropicBudgets`/`googleBudgets` tables in `model-provider-options.ts` were a
third, hand-maintained copy of data the generated variants file already
carried — and the direct-provider resolvers read the hand-maintained copy while
the `opencode-go` resolver read the generated one.

## Decision

- **Single output.** One generated file feeds catalog metadata. Splitting
  variants and pricing into separate generated artifacts is what allowed the
  drift; one file cannot drift from itself.
- **The converter never imports its own output.** Exactly one module reads the
  generated file: `model-metadata-runtime.ts`. The converter in `models-dev.ts`
  is pure, and the generator imports it, so an import of `./generated/*` there
  would close a cycle and break regeneration on a clean tree — the failure mode
  that motivated this constraint is that the file exists on every healthy
  checkout, so the cycle stays invisible until someone deletes it to regenerate.
  `scripts/generator-graph.test.ts` walks the generator's import graph and fails
  if that edge appears.
- **Manual overlays are a source, not an exception.** Some facts have no
  upstream: `reasoningSummaryModels` is an operator preference about requesting
  detailed reasoning summaries, and models.dev does not publish reasoning
  options for every catalog entry (post-prune: `opencode-go/gpt-5.6-luna`, the
  default model, has no upstream reasoning data at all). The script reports
  overlay-covered entries explicitly so the debt is counted, not hidden.
- **No invented baseline.** An `active` entry that upstream does not serve is
  a reported gap. The script never emits cost or limits it did not receive.
- **Provenance in the header.** Source URL, fetch date, catalog revision
  covered, per-entry counts, and the list of upstream-missing entries.

## Consequences

- `models.dev/api.json` `reasoning_options[]` is the upstream source for
  reasoning policy; `cost` (including `tiers[]` and `context_over_200k`) and
  `limit` are the upstream sources for pricing and limits.
- `ModelCost` has one definition, in `@wincode/ai`. The duplicate in
  `packages/tui/modules/model-pricing/model-pricing.ts` is removed.
- `MODEL_OUTPUT_TOKEN_LIMIT` stops pretending to be a model capability. The
  per-model `limit.output` lives in the catalog; the 32k figure remains a
  separate operational ceiling, and the thinking-budget clamp reads the
  effective minimum of the two.
- Snapshot staleness is expected, not a surprise: the catalog is a curated
  product definition, so an entry may legitimately be ahead of or behind
  upstream. The header records which epoch the metadata came from.
