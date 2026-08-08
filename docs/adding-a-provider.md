# Adding a Provider

Use this guide when adding a model provider to the AI package and CLI connection flow.

## Read first

Understand these identities before editing code:

- `connectionProviderId`: owns credentials and connection status in the CLI.
- `provider`: selects the AI SDK runtime resolver.
- `route`: selects `direct` or `hosted` execution.
- Model identity: `(connectionProviderId, modelId)`, not raw `modelId` alone.

For a direct provider, `connectionProviderId` and runtime `provider` must match. Hosted models use the Wincode connection while `provider` identifies the backend runtime.

## Choose the provider shape

### Direct API-key provider

Use this path for a provider whose models run locally through its AI SDK using a user-supplied API key.

Normal production onboarding requires five source edit locations:

1. `packages/ai/src/models.ts`
2. `packages/ai/src/server/providers/<provider>.ts`
3. `packages/ai/src/server/providers/registry.ts`
4. `apps/cli/src/modules/connections/provider-definition.ts`
5. `apps/cli/src/modules/connections/provider-registry.ts`

Provider-specific API-key validation, a new SDK dependency, and the lockfile are conditional extra changes.

### Hosted Wincode model

Do not create a new CLI credential provider. Add a hosted model catalog entry with:

```ts
{
  connectionProviderId: "wincode",
  provider: "<runtime-provider>",
  route: "hosted",
}
```

The Wincode connection authorizes the hosted protocol. The runtime provider only selects backend model behavior.

### OAuth provider

OAuth is not normal API-key onboarding. In addition to the five locations, it needs:

- a strict persisted credential schema;
- browser acquisition and callback handling;
- refresh behavior;
- authorization DTO mapping;
- abort, refresh, replacement-credential, and secret-redaction tests.

OpenAI OAuth and Wincode hosted OAuth are named implementations to study. Do not generalize them unless a new provider has identical semantics.

## Direct API-key implementation

### 1. Add provider and models

Edit `packages/ai/src/models.ts`.

- Add the connection ID to `connectionProviderIds`.
- Add the runtime ID to `modelRuntimeProviderIds`.
- Add direct catalog entries.
- Set `route: "direct"`.
- Keep `connectionProviderId` equal to `provider`.
- Declare variants on each catalog entry. OpenCode Go entries are the exception: their variants come from the generated models.dev snapshot (`packages/ai/src/generated/opencode-go-variants.generated.ts`, written by `scripts/sync-model-pricing.ts`), so keep their catalog variants empty.
- Preserve unique `(connectionProviderId, modelId)` pairs.

Do not assume model IDs are globally unique. The same model ID may exist under different connection providers.

### 2. Implement the runtime resolver

Create `packages/ai/src/server/providers/<provider>.ts`.

The module owns:

- AI SDK construction with API key;
- environment/default SDK construction;
- provider options;
- reasoning/thinking policy;
- output-token policy;
- provider-specific stable errors.

Use the actual model catalog entry for variant validation. Never synthesize a selection from only the runtime provider and model ID.

Implement the homogeneous resolver contract from:

```text
packages/ai/src/server/providers/contract.ts
```

Keep provider policy out of the registry and generic model dispatcher.

### 3. Register the runtime resolver

Edit `packages/ai/src/server/providers/registry.ts`.

- Import the resolver.
- Add its keyed registry entry.
- Keep key and resolver provider ID correlated.
- Keep the registry composition-only.

The runtime-provider completeness tests must fail if this step is missing.

### 4. Add the CLI provider definition

Edit `apps/cli/src/modules/connections/provider-definition.ts`.

The definition owns:

- provider ID and display name;
- literal supported methods;
- credential schema;
- API-key validation;
- `connect` behavior;
- authorization DTO;
- connected/disconnected status.

For an API-key-only provider:

```ts
methods: ["api-key"];
```

The derived request type must reject browser connection requests at compile time.

Keep schemas strict. Errors must not include API keys or provider responses containing secrets.

If validation needs a remote probe, add the provider-specific validator in:

```text
apps/cli/src/modules/connections/api-key-validation.ts
```

Validation is optional only when the provider cannot safely validate a key before first use.

### 5. Register the CLI provider

Edit `apps/cli/src/modules/connections/provider-registry.ts`.

- Add the factory to the keyed factory map.
- Add the provider to `providerOrder`.
- Add it to registry construction and service composition.
- Keep registry key equal to definition ID.
- Keep ordering deterministic.

Display-name, credential-schema, facade, vault, and UI metadata derive from provider definitions and registry composition.

## Files that should not need provider-specific edits

A normal API-key provider must not require a new provider branch in:

```text
apps/cli/src/modules/connections/facade.ts
apps/cli/src/modules/connections/v2-credential-vault.ts
apps/cli/src/modules/connections/ui/
apps/cli/src/modules/conversations/hooks/local-chat-transport.ts
packages/ai/src/server/models.ts
```

If one of these needs a provider-ID branch, stop and determine whether the behavior belongs in the provider definition or runtime resolver.

Allowed named exceptions:

- OpenAI direct OAuth authorization;
- Wincode hosted transport and bearer protocol.

## Required tests

### AI catalog

Update or add tests for:

- valid provider/model pairs;
- invalid cross-provider pairs;
- unique pair keys;
- direct route;
- supported and rejected variants.

### Runtime resolver

Update or add tests for:

- API-key resolution;
- environment resolution;
- provider options;
- reasoning/thinking variants;
- output-token boundaries;
- unsupported model and variant errors;
- registry completeness and key/provider correlation.

### CLI connection

Update or add tests for:

- exact methods tuple;
- API-key request type;
- browser request compile rejection;
- credential schema strictness;
- API-key validation success/failure;
- authorization DTO;
- provider order and registry completeness;
- credential vault roundtrip and invalid-record redaction;
- facade queue and authorization behavior.

Tests may add more files. The five-file target applies to normal production source edits, not test coverage or dependencies.

## Verification

Run from repository root:

```bash
bun test packages/ai/src
bun run --cwd packages/ai check-types
bun test apps/cli/src
bun run --cwd apps/cli check-types
bun run --cwd apps/server check-types
bun run check
git diff --check
```

Run integration build when adding an SDK or changing runtime construction:

```bash
bun run build
```

## Review checklist

- Provider/model pairs are valid and pair-unique.
- Direct entries have matching connection/runtime providers.
- Variants are validated against the selected catalog entry.
- Runtime registry is complete and composition-only.
- CLI definition owns provider behavior.
- CLI registry key, definition ID, and order are aligned.
- No provider branch was added to facade, vault, generic UI, or model dispatcher.
- Connect and authorize still share per-provider serialization.
- Caller abort does not cancel shared OAuth refresh.
- Credential errors redact secrets.
- Public exports and compatibility behavior remain stable.
