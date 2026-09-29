# Adding a direct model provider

Wincode runs model requests locally. A provider connection supplies credentials owned by the user; there is no Wincode account or hosted execution path.

## Model catalog

Add a direct entry to `packages/ai/src/catalog.ts`:

```ts
{
	connectionProviderId: "example",
	route: "direct",
	displayName: "Example Model",
	id: "example-model",
	provider: "example",
	lifecycle: "active",
}
```

For direct entries, `connectionProviderId` and `provider` must match one of the supported provider IDs. Model identity is the pair `(provider, modelId)`, not the model ID alone.

A new entry carries no reasoning levels, cost, or limits. Those come from the generated snapshot, so a model the upstream does not list needs a manual overlay in `packages/ai/scripts/metadata-model.ts` before it can offer any reasoning level at all. Run the generator and read its coverage report:

```sh
bun run packages/ai/scripts/sync-model-metadata.ts
```

It prints which entries came from the source, which from an overlay, and which are absent upstream. An `active` entry in the last group cannot offer levels, limits, or prices, and the report is the only place that gap is visible.

To retire a model instead of deleting it, set `lifecycle: "retired"`. Retired entries stay resolvable so existing Session Records keep their model identity, and they stop being selectable in the model picker. See [ADR-0012](adr/0012-model-catalog-lifecycle.md).

## Model policy and protocol clients

Reasoning options are translated once, in `packages/ai/src/model-provider-options.ts` (`resolveReasoning`), from the entry's published `ThinkingPolicy` into whichever provider shape reaches the wire. Do not add a per-model table for a provider: if a model needs a different level set or budget bound, that is a metadata problem, so fix the overlay or the upstream reading in `packages/ai/src/models-dev.ts`.

The `providerChosenBudgetModels` set in that file is the one hand-maintained exception, for providers that pick their own reasoning budget. Adding a model there is a deliberate statement, not a default.

Register one adapter per Connection Provider in
`packages/ai/src/model-client/provider-adapters/index.ts`. Each adapter owns its
default Model Protocol, endpoint, authorization, headers, and provider-specific
body policy; use existing Model Catalog protocol metadata only to override a
provider default. Do not add route configuration to every model.

Implement request-body serialization and streamed response parsing together in a
reusable Model Protocol strategy under
`packages/ai/src/model-client/protocols/`, then bind that strategy in the
provider adapter. The adapter carries the selected strategy through request
serialization and response streaming, with no second protocol-name lookup. The
provider-adapter registry is exhaustive and typed. A Connection Provider may
reuse an existing strategy, and unsupported provider/protocol combinations
must fail explicitly. Keep common SSE transport, usage normalization, and
error translation shared.

Keep callers on provider-neutral `ModelClient.stream()`. The Agent Runtime must
not acquire provider-specific wire behavior.

## CLI credentials

Add the provider definition in `packages/ai/src/connections/provider-definition.ts`:

- display name;
- supported connection methods;
- strict credential schema;
- credential validation;
- provider-neutral authorization used by the model client;
- connection status.

Add the factory and deterministic order entry in `packages/ai/src/connections/provider-registry.ts`. The provider must be present in the model catalog, resolver registry, and AI connection registry together.

## Validation

Run:

```sh
bun run --cwd packages/coding-agent check-types
bun run --cwd packages/coding-agent test
bun run test
bun run check
```

Add focused tests for catalog route coverage, request serialization, stream/error mapping, credential validation, and provider registration. Do not add account, subscription, quota, hosted transport, remote session, or billing behavior.
