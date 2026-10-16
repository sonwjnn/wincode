# Adding a Provider SDK implementation

Wincode executes model requests through the Provider SDK. A Provider owns its model identity, authorization resolution, protocol request/stream behavior, and any Provider-scoped resources; Coding-Agent owns credential persistence and selection.

## Provider Models

Declare baseline `ProviderModel` values or implement `discoverModels` in the Provider. Every model must use the exact Provider ID and model ID that consumers select:

```ts
const models: readonly ProviderModel[] = [
	{
		modelId: "example-model",
		protocolId: "example-protocol",
		providerId: "example",
	},
];
```

Capabilities, reasoning efforts, cache tiers, context/output limits, and pricing are optional published metadata. Do not infer missing metadata from a neighboring model. Dynamic discovery returns Provider-owned models and failed refreshes must preserve the last-known snapshot.

## Provider implementation

Add the implementation under `packages/ai/src/sdk-providers/`. Implement `resolveAuthorization` and `streamChat` against the Provider SDK contracts in `packages/ai/src/sdk.ts`; keep credentials in Provider authorization state, not in chat requests or model identity. Reuse protocol serializers, stream parsers, and errors from `packages/ai/src/sdk-private/` when appropriate. Do not introduce a Model Target, Model Client, Catalog adapter, or Connections execution fallback.

Each provider entry point is separately exported through `@wincode/ai/sdk/providers/*`. Keep the SDK core independent from built-in provider imports. Register built-in construction and connection metadata in `packages/coding-agent/modules/providers/built-in-provider-catalog.ts`; the Session Provider collection composes catalog Providers with Plugin Providers from the trusted Plugin registration path.

## Validation

Use fake-only tests at the public Provider SDK seam. Cover the observable request payload, stream events and usage, continuation, supported reasoning/cache behavior, authentication/provider/transport failures, abort, and exact Provider Model identity. Do not call live endpoints or use real credentials.

Run focused tests for the Provider, then `bun fix`, `bun check`, `bun check-types`, the default test suite, and the E2E suite. Do not add account, subscription, quota, hosted transport, remote session, or billing behavior.
