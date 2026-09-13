# Cost and limits belong to the Model Catalog

A catalog entry carries its cost rates, cost tiers, and context/output limits
as model metadata. Remote pricing refresh updates those values; it is no longer
the only place they exist.

Status: accepted

## Context

`ModelCost` was declared in `@wincode/ai` but no catalog entry used it. The
only cost and context-limit data in the product lived in a runtime
`ModelPricingTable` owned by the TUI, populated from a `models.dev` fetch with
a five-second timeout and a 50% coverage floor, backed by an orphaned snapshot.

The consequence was not cosmetic. `contextLimit` is the precondition for
automatic compaction: `resolveCompactionSettings` reads it from the pricing
table and emits `unknown-context-limit`, disabling automatic compaction, when
the fetch did not cover the selected model. A five-second network timeout
therefore decided whether the feature existed.

`calculateModelUsageCostUsd` and `formatModelUsdAmount` were implemented and
covered by tests but called from nowhere; no user has ever seen a cost figure.
The cost formula also ignored cache-write tokens entirely and fell back to the
input rate for cache reads, which misprices the long-cache providers the
catalog already supports.

## Decision

- Context limits, output limits, and cost rates live on the catalog entry.
- The runtime pricing fetch becomes a *refresh* of those values plus a source
  of `stale`/`refreshedAt` provenance, not the sole origin.
- Cost modeling covers context tiers (`tiers[]`, with `context_over_200k`
  folded in as a tier at parse time) and cache read/write rates. A rate the
  upstream does not provide is absent, never defaulted to another rate.
- Cache-write cost is computed only when the model publishes a cache-write
  rate. 51 of the 72 pre-prune entries had none — for OpenAI and Google the
  field is genuinely not applicable, not missing.
- The session usage bar shows an estimated session cost next to the context
  measure, labelled as an estimate. Estimated cost is never presented as
  billing.

## Why the runtime refresh stays

Measured against the committed `2026-08-08` snapshot and `models.dev` live on
`2026-09-12` — a 35-day window — 8 of 66 compared entries had changed price
across 25 field instances. The largest was `opencode-go/deepseek-v4-pro
cacheRead`, up 507%. The default model moved too: `gpt-5.6-luna` doubled on
both input and output. Prices move in both directions and by far more than a
rounding error, so a cost derived only from a build-time snapshot can be wrong
by a large factor between releases.

That makes the refresh worth its complexity *because* the cost is displayed.
Its complexity is bounded by one rule from ADR-0014: the committed snapshot and
the fetched table are both read through `@wincode/ai/models-dev`, so the two can
differ only in how current they are, never in how a field is interpreted. A
live table overrides per field and never adds or removes catalog entries — the
allowlist stays a product decision.

All three upstream projects keep a bundled baseline plus an optional runtime
overlay and retain stale data on failure: Pi ships generated catalogs and
fetches only for dynamic providers (in-memory store, no TTL, explicit refresh);
OpenCode caches `models.json` on disk with a 5-minute mtime check and refreshes
at startup and every 60 minutes; OMP layers bundled, cached, remote, and
discovered sources with a 2-hour TTL in SQLite and records non-authoritative
snapshots on failure. Wincode matches that shape.

The alternative — deleting the fetch and relying on the snapshot alone — was
rejected because a cost derived only from a build-time snapshot can be wrong by
a large factor between releases. Deleting the snapshot and relying on the fetch
alone would be worse: a cold start with no network would have no context limit,
which is the precondition for automatic compaction.

## Staleness is measured but not displayed

The data needed to judge how current a price is exists and is resolved: the
pricing state carries a `source` of `"bundled"`, `"cache"`, or `"stale"`, and
the generated metadata module exports `modelMetadataSnapshotDate`, the date the
build-time data came from.

No surface displays it. A decision was made to show the estimated cost with its
`~` marker and nothing else, so a reader cannot tell whether a figure came from
today's fetch or a snapshot several weeks old. That is a deliberate choice and
not an inconsistency to repair casually.

The state is one step away from the surface: `useModelPricing()` returns both
`source` and `snapshotDate`, but `summarizeSessionUsage` does not carry them
into `SessionUsageSummary`, so `SessionUsageBar` never sees them. Displaying
the mark again means adding a field to that summary and passing it from the two
call sites, not recomputing anything.

## Consequences

- `resolveModelMetadata` in the TUI remains, but resolves from the catalog
  entry with a runtime override layer; it stops being the only path to a
  context limit.
- The `ModelPricingEntry` shape and its Zod schema stay TUI-owned, because
  caching, TTL, and coverage policy are TUI concerns. The `ModelCost` shape
  itself moves to `@wincode/ai` and the duplicate is deleted.
- Cost remains an estimate derived from published rates. Wincode has no
  account, subscription, credit, or quota surface, and this decision creates
  none.
