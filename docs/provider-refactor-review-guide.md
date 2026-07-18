# Provider Registry Refactor Review Guide

## Review goal

Confirm the refactor reduces normal API-key provider onboarding to five source edit locations without changing existing model resolution, authentication, credential storage, routing, or concurrency behavior.

Expected onboarding locations:

1. `packages/ai/src/models.ts` — provider ID and model catalog.
2. `packages/ai/src/server/providers/<provider>.ts` — SDK resolver and model policy.
3. `packages/ai/src/server/providers/registry.ts` — runtime resolver composition.
4. `apps/cli/src/modules/connections/provider-definition.ts` — credential and authorization behavior.
5. `apps/cli/src/modules/connections/provider-registry.ts` — CLI provider composition and order.

SDK-specific validation, package manifest, and lockfile changes are conditional extras.

## Before reviewing

Start with both tracked and untracked files. `git diff` does not show untracked files.

```bash
git status --short
git diff --stat
git diff --check
```

Important new files currently include:

```text
packages/ai/src/server/providers/
apps/cli/src/modules/connections/credential-schemas.ts
apps/cli/src/modules/connections/provider-definition.ts
apps/cli/src/modules/connections/provider-registry.ts
apps/cli/src/modules/connections/provider-registry.test.ts
```

## Recommended review flow

### 1. Model vocabulary and catalog

Review:

```text
packages/ai/src/models.ts
packages/ai/src/models.test.ts
```

Verify:

- `connectionProviderId` identifies credential ownership.
- `provider` identifies AI SDK/runtime provider.
- `route` identifies execution path: `direct` or `hosted`.
- Direct models require `connectionProviderId === provider` at compile time.
- Hosted models may use a different runtime provider.
- Provider/model pairs remain unique; raw model IDs may repeat across providers.
- Legacy string normalization still resolves to Wincode-hosted models.
- Variant validation uses the selected catalog entry, not another entry sharing the same model ID.

Useful diff:

```bash
git diff -- packages/ai/src/models.ts packages/ai/src/models.test.ts
```

### 2. AI runtime resolver registry

Review:

```text
packages/ai/src/server/providers/contract.ts
packages/ai/src/server/providers/registry.ts
packages/ai/src/server/providers/openai.ts
packages/ai/src/server/providers/anthropic.ts
packages/ai/src/server/providers/google.ts
packages/ai/src/server/models.ts
packages/ai/src/server/models.test.ts
```

Verify:

- `server/models.ts` is a thin dispatcher/facade.
- Registry is complete and key/provider correlated.
- Provider modules own SDK construction and provider-specific options.
- API-key and environment resolution remain distinct.
- OpenAI OAuth remains a named special resolver.
- Anthropic and Google budget validation uses the selected `high` or `max` budget.
- `maxOutputTokens` remains capped at `32_000` where required.
- Unsupported variants and providers retain stable errors.
- No provider switch or provider-ID cast remains in generic resolver dispatch.

Useful diff:

```bash
git diff -- packages/ai/src/server
```

### 3. CLI provider definitions and derived contracts

Review in dependency order:

```text
apps/cli/src/modules/connections/credential-schemas.ts
apps/cli/src/modules/connections/provider-definition.ts
apps/cli/src/modules/connections/provider-registry.ts
apps/cli/src/modules/connections/provider-adapters.ts
apps/cli/src/modules/connections/contract.ts
apps/cli/src/modules/connections/provider-registry.test.ts
apps/cli/src/modules/connections/contract.test.ts
```

Verify:

- Credential/progress leaf types do not import `contract.ts`.
- Provider definitions own display name, methods, schema, connect, authorize, and status behavior.
- `provider-adapters.ts` is only a compatibility bridge.
- Registry owns provider order and composition.
- `CredentialByProvider`, `AuthorizationByProvider`, and connect request types are derived.
- API-key-only providers cannot accept browser requests at compile time.
- Registry and provider modules do not import the derived contract.
- Exact request, credential, authorization, order, and completeness tests are independent and discriminating.

Dependency direction should be:

```text
credential/progress leaves
  -> OAuth, validation, browser integrations
  -> provider definitions
  -> provider registry
  -> derived contract, facade, vault, UI
```

Useful diff:

```bash
git diff -- apps/cli/src/modules/connections/contract.ts \
  apps/cli/src/modules/connections/provider-adapters.ts
```

Review new provider files directly because they may still be untracked.

### 4. Credential vault security

Review:

```text
apps/cli/src/modules/connections/v2-credential-vault.ts
apps/cli/src/modules/connections/v2-credential-vault.test.ts
```

Verify:

- Schema and display name come from provider registry metadata.
- JSON is parsed once.
- Generic load/replace preserve provider-specific return types.
- The localized Zod-boundary assertion is the only correlation assertion here.
- Secret-store account remains `connections-v2:<providerId>`.
- File location remains `~/.wincode/connections-v2/<providerId>.json`.
- Directory/file modes remain `0700` and `0600`.
- Symlink, non-regular-file, insecure-directory, and atomic-write protections remain.
- Invalid stored credentials do not expose secret content.

### 5. Facade concurrency and lifecycle

Review:

```text
apps/cli/src/modules/connections/facade.ts
apps/cli/src/modules/connections/facade.test.ts
```

This is the highest-risk behavioral section.

Verify:

- Registry owns provider composition; facade contains no provider literals or provider switches.
- Connect and authorize share the same per-provider queue.
- Different providers remain independent.
- Connect invalidates cached authorization before enqueueing.
- Authorization is singleflight only while pending; settled operations clear cache.
- Caller abort cancels only that caller's wait.
- Caller abort is not forwarded into shared OAuth refresh.
- Replacement credentials persist before authorization resolves.
- Connect checks abort before credential persistence.
- Browser progress order remains `starting -> ... -> connected`.
- Invalid stored credentials produce disconnected status; operational failures propagate.
- The one heterogeneous runtime-adapter assertion is localized and documented.

Pay special attention to tests that start authorize while connect is still blocked. A test that awaits connect first does not prove serialization.

### 6. Routing and UI consumers

Review:

```text
apps/cli/src/modules/conversations/hooks/local-chat-transport.ts
apps/cli/src/modules/conversations/hooks/routing-chat-transport.ts
apps/cli/src/modules/conversations/hooks/chat-transport.test.ts
apps/cli/src/modules/connections/ui/connection-dialog-options.ts
apps/cli/src/modules/connections/ui/connection-api-key-dialog.tsx
```

Verify:

- Route decisions use model-owned `route`, not provider-name heuristics.
- Direct transport authorizes dynamically and dispatches by authorization kind.
- API-key authorization is generic.
- OpenAI OAuth is the only explicit direct OAuth exception.
- Bearer authorization cannot enter direct transport.
- Wincode hosted bearer/request protocol remains explicit.
- Generic connection UI contains no Anthropic/Google provider-ID branches.
- Label width derives provider registry display names.

### 7. Documentation and onboarding proof

Review:

```text
apps/cli/src/modules/connections/README.md
```

Verify the documented five source edit locations match actual composition points. Tests are expected to change but are not production onboarding files.

## Important keywords

### Identity and routing

- `ConnectionProviderId` — credential owner, such as `wincode` or `openai`.
- `ModelRuntimeProviderId` — AI SDK implementation, such as `openai`, `anthropic`, or `google`.
- `connectionProviderId` — model catalog field selecting credential owner.
- `provider` — model catalog field selecting runtime resolver.
- `route` — `direct` or `hosted` execution path.
- provider/model pair — canonical identity is `(connectionProviderId, modelId)`, not raw model ID.

### Registry architecture

- provider definition — provider-owned schema, methods, connect, authorize, and status behavior.
- composition registry — explicit keyed registration and order; no provider business logic.
- derived contract — types inferred from provider definitions instead of handwritten maps.
- compatibility bridge — temporary/stable facade preserving an existing public import while delegating to registry definitions.
- key/value correlation — registry key must equal definition/resolver provider ID.
- completeness invariant — every provider ID appears exactly once.

### Authentication and credentials

- `api-key` — direct API-key authorization.
- `oauth` — OpenAI direct OAuth authorization.
- `bearer` — Wincode hosted authorization.
- `oauth-session` — persisted refreshable credential.
- `replacementCredential` — refreshed credential persisted before authorization completes.
- credential schema — Zod schema validating stored provider credentials.

### Concurrency

- per-provider queue — serializes connect and authorize for one provider.
- singleflight — concurrent authorization callers share one pending refresh.
- caller-only abort — abort rejects one waiter without cancelling shared refresh.
- cache invalidation-before-enqueue — a new connect cannot reuse stale authorization.
- stale refresh overwrite — race where old OAuth refresh replaces a newly connected credential; queue must prevent it.

### Named exceptions

- OpenAI OAuth — custom ChatGPT Codex base URL, account header, and OAuth authorization shape.
- Wincode hosted protocol — hosted transport, bearer header, server request gate, and legacy string model normalization.
- localized assertion boundary — one documented assertion where TypeScript cannot retain heterogeneous registry correlation at runtime.

## Red flags

Reject or investigate changes introducing:

- New provider switch in facade, vault, generic UI, or model dispatcher.
- Provider display names or method lists duplicated outside definitions/registry.
- `connectionProviderId === "wincode"` used as a generic route test.
- Variant validation synthesized from runtime provider instead of selected catalog entry.
- Registry importing derived `contract.ts`.
- Caller abort signal passed into shared provider refresh.
- Connect and authorize using different queues.
- `Object.fromEntries(...) as ...`, `as any`, or `as never` in production registry code.
- Tests whose expected value is derived from the implementation field being tested.
- Tests that do not create an actual overlapping race.

## Verification commands

Focused validation:

```bash
bun test packages/ai/src
bun run --cwd packages/ai check-types
bun test apps/cli/src
bun run --cwd apps/cli check-types
bun run --cwd apps/server check-types
bun run check
git diff --check
```

Integration build:

```bash
bun run build
```

Known unrelated baseline:

```text
bun run --cwd apps/web check-types
```

Currently fails at `apps/web/vite.config.ts:29` with `TS2769` alias typing, while the web production build succeeds.
