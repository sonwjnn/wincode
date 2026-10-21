# Adding a Provider SDK implementation

Wincode executes model requests through the Provider SDK. A Provider owns its model identity, authorization resolution, protocol request/stream behavior, and any Provider-scoped resources; Coding-Agent owns credential persistence and selection.

## Provider Models

For built-in static inventories, add model IDs to `packages/ai/scripts/provider-model-catalog.source.json`. Declare the provider's default protocol once; use a model object only for a protocol or capability override. Run `bun run sync-provider-model-catalog`; it combines the manifest with models.dev facts and `packages/ai/scripts/metadata-model.ts` overlays, then imports the generated `packages/ai/src/generated/<provider>.generated.ts` baseline directly from the provider factory. Metadata enriches listed models but never adds identities. Do not keep a parallel `*-models.ts` wrapper.

When adding a model fact that models.dev does not publish, add a keyed manual overlay in `metadata-model.ts`. The generator only applies overlays to models already present in the provider manifest.

Use `discoverModels` for account- or endpoint-specific inventories instead of adding them to the static baseline. Every returned model must use the exact Provider ID and model ID that consumers select. Capabilities, reasoning efforts, cache tiers, context/output limits, and pricing are optional published metadata. Do not infer missing metadata from a neighboring model.

Call `ProviderCollection.refreshModels()` explicitly to refresh every registered provider with `discoverModels`; pass `providerIds` to limit the refresh. Static providers are skipped. The result reports caller cancellation in `aborted` and per-provider failures in `errors`, so one provider's failure does not block other refreshes. Refresh failures preserve last-known snapshots. Call `restoreModels()` after registering providers to load persisted snapshots without network access.

## Provider implementation

Add the implementation under `packages/ai/src/sdk-providers/`. Implement `resolveAuthorization` and `streamChat` against the Provider SDK contracts in `packages/ai/src/sdk.ts`; keep credentials in Provider authorization state, not in chat requests or model identity. HTTP Providers implement `getChatHeaders` to return protocol defaults and authorization-derived headers before dispatch, then send `ProviderChatContext.headers` verbatim; do not reapply defaults in `streamChat`. `ProviderCollection` merges those headers with provider, model, and request overrides case-insensitively before the optional asynchronous request transform. A `null` override removes a lower-level header. Treat the final transform as trusted code: it can replace auth headers, and secret-bearing values must not be logged. This pipeline applies to chat only, not discovery or OAuth. Factories must reject unsupported Provider or protocol IDs at construction so a bad manifest mapping cannot become selectable. Reuse protocol serializers, stream parsers, and errors from `packages/ai/src/sdk-private/` when appropriate. Do not introduce a Model Target, Model Client, Catalog adapter, or Connections execution fallback.

The package root, `@wincode/ai`, re-exports the Provider SDK, built-in provider factories, and shared model helpers; use it for application and test imports. Existing SDK and model-helper subpath exports remain available. Keep `packages/ai/src/sdk.ts` independent from built-in provider imports. Register built-in construction and connect-method metadata in `packages/coding-agent/modules/providers/built-in-provider-catalog.ts`; bind method IDs to their distinct controller handlers in `packages/coding-agent/modules/providers/interactive-provider-controller.ts`. The connect dialog consumes executable method descriptors by capability rather than branching on provider IDs. Keep API-key persistence, discovery, OAuth/device, and trusted Plugin connection flows distinct. The Session Provider collection composes catalog Providers with Plugin Providers from the trusted Plugin registration path.

## Validation

Use fake-only tests at the public Provider SDK seam. Cover the observable request payload, stream events and usage, continuation, supported reasoning/cache behavior, authentication/provider/transport failures, abort, and exact Provider Model identity. Do not call live endpoints or use real credentials.

Run focused tests for the Provider, then `bun fix`, `bun check`, `bun check-types`, the default test suite, and the E2E suite. Do not add account, subscription, quota, hosted transport, remote session, or billing behavior.
