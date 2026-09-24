# Connections

The `@wincode/ai/connections` subpath owns direct provider credentials and runtime behavior. Coding-Agent keeps the React context and connection dialogs here.

## Providers

- `openai`: API key or provider-supported browser OAuth
- `anthropic`: API key
- `google`: API key
- `opencode-go`: API key

## Connection APIs

- `createConnections()` from `@wincode/ai/connections` creates the backend facade.
- `ConnectionsProvider` and `useConnections()` expose the facade to app-owned UI.
- Public behavior is limited to listing providers, connecting, and authorizing.
- Credential validation, OAuth refresh, secure storage, and provider adapters remain internal to the AI package.

## Storage

Credentials are stored in the platform secret store when available, with a secure local file fallback under the user's Wincode configuration directory. Session history and attachments use a separate local database.

## Provider onboarding

Canonical contributor instructions are in [`docs/adding-a-provider.md`](../../../../docs/adding-a-provider.md).

1. A model entry in `packages/ai/src/catalog.ts`.
2. Native request and stream handling under `packages/ai/src/model-client/`.
3. A credential definition in `packages/ai/src/connections/provider-definition.ts`.
4. A registry entry in `packages/ai/src/connections/provider-registry.ts`.
5. Manifest and lockfile updates when a new protocol dependency is needed.

Every selectable model must have a supported protocol route and credential path. Keep provider order deterministic and preserve unique `(provider, modelId)` pairs.
