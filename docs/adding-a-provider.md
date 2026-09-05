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

## Model policy and runtime adapter

Add provider-specific model option policy to `packages/ai/src/model-provider-options.ts`. Keep its return value provider-neutral and typed, including capability-specific option shapes.

Add the private runtime implementation under `packages/agent-runtime-ai-sdk/src/providers/`, construct the model from the user-owned authorization, and translate only at the runtime boundary.

Register the resolver in `packages/agent-runtime-ai-sdk/src/providers/registry.ts`. AI SDK imports must remain inside `@wincode/agent-runtime-ai-sdk`.

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
