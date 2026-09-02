# Connections

The connections module owns direct model-provider credentials for the CLI.

## Providers

- `openai`: API key or provider-supported browser OAuth
- `anthropic`: API key
- `google`: API key
- `opencode-go`: API key

## Connection APIs

- `createConnections()` creates the application facade.
- `ConnectionsProvider` and `useConnections()` expose the process-scoped facade.
- Public behavior is limited to listing providers, connecting, and authorizing.
- Credential validation, OAuth refresh, secure storage, and provider adapters remain internal.

## Storage

Credentials are stored in the platform secret store when available, with a secure local file fallback under the user's Wincode configuration directory. Conversation history and attachments use a separate local database.

## Provider onboarding

Canonical contributor instructions are in [`docs/adding-a-provider.md`](../../../../../docs/adding-a-provider.md).

A provider normally requires:

1. A direct model entry in `packages/ai/src/models.ts`.
2. A resolver under `packages/ai/src/server/providers/`.
3. A resolver entry in `packages/ai/src/server/providers/registry.ts`.
4. A credential definition in `provider-definition.ts`.
5. A registry entry in `provider-registry.ts`.
6. Manifest and lockfile updates when a new SDK dependency is needed.

For direct models, the connection provider and runtime provider identify the same provider. Every selectable model must have a matching resolver and credential path. Keep provider order deterministic and preserve unique `(provider, modelId)` pairs.
