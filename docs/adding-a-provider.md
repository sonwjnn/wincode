# Adding a direct model provider

Wincode runs model requests locally. A provider connection supplies credentials owned by the user; there is no Wincode account or hosted execution path.

## Model catalog

Add a direct entry to `packages/ai/src/models.ts`:

```ts
{
  connectionProviderId: "example",
  route: "direct",
  displayName: "Example Model",
  id: "example-model",
  provider: "example",
  variants: [],
}
```

For direct entries, `connectionProviderId` and `provider` must match one of the supported provider IDs. Model identity is the pair `(provider, modelId)`, not the model ID alone.

## Resolver

Create `packages/ai/src/server/providers/example.ts` using the shared resolver contract. The resolver must construct the AI SDK model from a user-owned API key and expose any provider-specific options needed by the local agent loop.

Register the resolver in `packages/ai/src/server/providers/registry.ts`.

## CLI credentials

Add the provider definition in `apps/cli/src/modules/connections/provider-definition.ts`:

- display name;
- supported connection methods;
- strict credential schema;
- credential validation;
- authorization for the provider SDK;
- connection status.

Add the factory and deterministic order entry in `provider-registry.ts`. The provider must be present in the model catalog, resolver registry, and CLI registry together.

## Validation

Run:

```sh
bun run --cwd apps/cli check-types
bun check-types
bun test apps/cli/src packages/ai/src
bun run check
```

Add focused tests for model selection, resolver behavior, credential validation, and the provider registry. Do not add account, subscription, quota, hosted transport, remote session, or billing behavior.
