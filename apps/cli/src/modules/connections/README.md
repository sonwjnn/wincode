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

## Adding A Provider

1. Add the shared provider ID and model catalog entries in `@wincode/ai`.
2. Add one static provider adapter with metadata, connect, and authorize behavior.
3. Add adapter contract tests. Storage, UI, and chat routing derive from the facade.
