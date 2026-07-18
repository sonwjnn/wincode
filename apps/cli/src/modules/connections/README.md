# Connections

Facade-only CLI connections module.

## Providers

- `wincode`: browser OAuth or API key
- `openai`: browser OAuth or API key
- `anthropic`: API key
- `google`: API key

## Connection APIs

- `createConnections()` creates the facade.
- `ConnectionsProvider` and `useConnections()` expose one app-owned instance.
- Public behavior is limited to listing providers, connecting, and authorizing.
- Validation, OAuth, refresh, credentials, and storage remain internal.

## Storage

- v1 data untouched, unsupported
- no migration/read path remains
- Bun account: `connections-v2:<provider>` under service `wincode`
- File fallback: `~/.wincode/connections-v2/<provider>.json`

## Provider Onboarding Contract

Normal production provider onboarding has five source edits:

1. **AI model catalog** — add the connection/runtime IDs and model entries in
   `packages/ai/src/models.ts`.
2. **AI resolver module** — add the provider SDK resolver under
   `packages/ai/src/server/providers/`.
3. **AI resolver registry** — register that resolver in
   `packages/ai/src/server/providers/registry.ts`.
4. **CLI definition/factory** — add the provider definition factory in
   `apps/cli/src/modules/connections/provider-definition.ts`. The definition owns
   display metadata, supported methods, credential schema, connect, authorize,
   and status behavior.
5. **CLI registry composition** — add the factory and composition/order entries in
   `apps/cli/src/modules/connections/provider-registry.ts`.

An SDK dependency may also require a package manifest update and lockfile update.
Do not assume a fixed number of dependency files.

### Model routes

- `route: "direct"`: `connectionProviderId` and runtime `provider` are the same
  provider; CLI credentials authorize that provider's SDK.
- `route: "hosted"`: the connection provider is `wincode`; runtime `provider`
  identifies the hosted model's backend. Do not add hosted models as direct
  provider credentials.
- Every model selection must match the catalog by both model ID and connection
  provider ID. Variants belong to the catalog entry.

### Exceptions

- **OpenAI OAuth** is a named CLI exception: OpenAI supports both API-key and
  browser OAuth, with OAuth refresh and account ID authorization handled by its
  definition.
- **Wincode hosted protocol** is a named exception: Wincode browser/API-key
  credentials authorize the hosted protocol, not the runtime provider named by a
  hosted model.

### Registry invariants and validation

- Every `ConnectionProviderId` has exactly one CLI factory and one composed
  definition; registry keys, IDs, and provider order stay aligned.
- Every direct model has a matching runtime resolver and CLI definition.
- Resolver registry covers every `ModelRuntimeProviderId`; hosted models still
  use the Wincode connection definition.
- Keep provider order deterministic. Preserve unique model selection pairs.

Run validation from repo root:

```sh
bun run check
```

The connections facade, credential vault, and UI derive provider lists, storage
plumbing, and presentation from these definitions/registries. No separate manual
edits are needed for those surfaces.
