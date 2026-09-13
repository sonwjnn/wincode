# OpenCode Go routes: LongCat 2.0 and Muse Spark Contributor

- **Research date:** 2026-09-13
- **Scope:** Determine whether OpenCode's own primary sources prove the model availability and wire/SDK route for three Go catalog candidates.
- **Evidence rule:** A model-list response proves an ID is currently advertised; it does **not** prove the request protocol or SDK adapter. Family/name similarity is not route evidence.

## Executive conclusion

All three IDs are currently advertised by OpenCode Go, and OpenCode's official Go endpoint table explicitly assigns their routes and AI SDK packages. The route evidence is therefore sufficient to add all three to a catalog that models the existing Go adapter choices:

| Model ID | Availability evidence | Official route/protocol evidence | Confidence | Safe to add now? |
| --- | --- | --- | --- | --- |
| `longcat-2.0` | Listed in the Go documentation and returned by the official Go `/models` endpoint. | `https://opencode.ai/zen/go/v1/chat/completions`; `@ai-sdk/openai-compatible`. | **High** | **Yes**, with `sdk: "openai-compatible"`. |
| `muse-spark-1.3-contributor` | Listed in the Go documentation and returned by the official Go `/models` endpoint. | `https://opencode.ai/zen/go/v1/responses`; `@ai-sdk/openai`. | **High** | **Yes**, with `sdk: "openai"`. |
| `muse-spark-1.2-contributor` | Listed in the Go documentation and returned by the official Go `/models` endpoint. | `https://opencode.ai/zen/go/v1/responses`; `@ai-sdk/openai`. | **High** | **Yes**, with `sdk: "openai"`. |

The Muse Spark rows are marked **limited regions** in the Go documentation. That is an availability constraint for users, not ambiguity about the wire route.

## Primary-source evidence

### 1. OpenCode Go documentation (route proof)

The official OpenCode Go page's **Endpoints** table identifies, per model, the endpoint and AI SDK package. It lists:

- `longcat-2.0` → `https://opencode.ai/zen/go/v1/chat/completions` → `@ai-sdk/openai-compatible`.
- `muse-spark-1.3-contributor` → `https://opencode.ai/zen/go/v1/responses` → `@ai-sdk/openai`.
- `muse-spark-1.2-contributor` → `https://opencode.ai/zen/go/v1/responses` → `@ai-sdk/openai`.

Sources: [rendered Go docs, Endpoints](https://opencode.ai/docs/go/#endpoints); [official Go docs source at OpenCode commit `95daf90670b7c039c436c85537da5fbfe2205b41`](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/web/src/content/docs/go.mdx).

The same official page lists all three in the current Go model roster. It also says Muse Spark 1.3/1.2 Contributor are available only in limited regions and links Meta's [Geographic Use Policy](https://ai.developer.meta.com/legal/geographic-use-policy).

### 2. Official Go `/models` response (availability, not route proof)

A retrieval of [the official OpenCode Go models endpoint](https://opencode.ai/zen/go/v1/models) returned these records:

```json
[
  {"id":"longcat-2.0","object":"model","owned_by":"opencode"},
  {"id":"muse-spark-1.3-contributor","object":"model","owned_by":"opencode"},
  {"id":"muse-spark-1.2-contributor","object":"model","owned_by":"opencode"}
]
```

The response is an OpenAI-style model list containing IDs and ownership, but no endpoint, protocol, SDK package, or capability field. It independently confirms current advertisement only; the route assignments above come from the Go endpoint table, not from this response.

### 3. Official OpenCode config and runtime source

OpenCode's model configuration documentation defines the full model identity as `provider_id/model_id`, and the Go page gives the concrete form `opencode-go/<model-id>` ([Models docs](https://opencode.ai/docs/models); [Go docs source](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/web/src/content/docs/go.mdx)). Thus these IDs belong under the `opencode-go` connection/provider namespace; they are not the similarly named Zen models (`opencode/muse-spark-1.3` or `opencode/muse-spark-1.2`).

The inspected official runtime source registers the relevant AI SDK packages (`@ai-sdk/openai` and `@ai-sdk/openai-compatible`) and loads provider/model metadata through the OpenCode model service ([provider runtime source](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/opencode/src/provider/provider.ts); [model metadata loader](https://github.com/anomalyco/opencode/blob/95daf90670b7c039c436c85537da5fbfe2205b41/packages/core/src/models-dev.ts)). Those source files establish the runtime's SDK/provider architecture, but do not replace the per-model route table; no family-based route inference was used.

## What is proven vs. what is missing

- **Proven:** all three model IDs are advertised by Go; the official Go documentation explicitly maps each one to a concrete endpoint and AI SDK package.
- **Not proven by `/models`:** the list response does not describe wire routes; an ID appearing there alone would be insufficient.
- **Not inferred:** LongCat is not assigned to OpenAI-compatible merely because it is an open model, and Muse Spark is not assigned to Responses merely because it is a Meta model. Those assignments come directly from OpenCode's per-model endpoint table.
- **Remaining operational caveat:** Muse Spark Contributor access is region-limited, so a successful catalog entry does not guarantee that every user's Go request is eligible. The route itself is unambiguous.

## Catalog recommendation

Add all three only with the exact IDs and SDK routes above. Do not use the Zen IDs, and do not route LongCat through `responses` or either Contributor model through `chat/completions`. Re-check the official Go endpoint table and `/models` response when OpenCode changes its model roster, because the page explicitly says that the list may change.
