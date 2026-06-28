# Core Architecture — Vertical Slices + Internal Layers

## 1. Outcomes

The architecture must provide:

- **High cohesion:** everything owned by a feature stays in one module.
- **Business-first navigation:** the folder tree reflects what the product does.
- **Incremental adoption:** slices begin small and acquire structure only when needed.
- **Discoverability:** developers can locate a capability without searching technical folders.

Rules define ownership and dependency direction. A folder tree alone is not architecture.

## 2. Top-level structure

```text
src/
├── app/                     # Routes, providers, bootstrap, application shells
├── modules/                 # Business capabilities / vertical slices
│   ├── cart/
│   ├── catalog/
│   └── checkout/
└── shared/                  # Domain-neutral cross-module foundations
```

Top-level app-wide folders such as `src/components`, `src/hooks`, `src/services`,
`src/stores`, and `src/types` are not feature destinations. Classify their contents into
`app`, an owning module, or `shared`.

## 3. Dependency direction

```text
app  ─────────> modules ─────────> shared

shared  -X-> modules
shared  -X-> app
modules -X-> app
```

### 3.1 App

`app/` wires routes, providers, error boundaries, layouts, and modules together. It must not
own feature business rules. A cross-feature workflow with business behavior belongs in a
dedicated orchestration module.

### 3.2 Modules

Sibling-module imports should be avoided. Prefer app-level composition or a workflow module.
When a direct dependency is justified:

- import only from a declared public entrypoint;
- record it in the consuming module's README;
- keep the graph one-way.

Do not move a domain-owned type to `shared` merely to silence a cycle. `CartItem` remains
owned by `cart` even when another module consumes it.

### 3.3 Shared and dependency inversion

`shared/` must not import from `modules/` or `app/`. Shared code must not contain feature
names, feature branches, or assumptions about feature state.

Cross-cutting infrastructure receives feature-owned data through configuration or an
injected interface:

```text
app/providers  ──configures──> shared/api (token provider/interceptor)
shared/api     -X-> modules/auth
```

The API client knows how to attach credentials; the auth module owns the token and auth state.

## 4. Shared ownership

The following is an allowlist, not a required scaffold:

| Path                 | Owns                                                       | Must not own                             |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------- |
| `shared/ui/`         | Design primitives and domain-neutral UI patterns           | Feature forms/modals/shells              |
| `shared/hooks/`      | Generic technical hooks                                    | Feature policy or feature API hooks      |
| `shared/api/`        | Transport, HTTP client, credential attachment mechanism    | Tokens, endpoints, query keys            |
| `shared/state/`      | Theme, connectivity, other domain-neutral technical state  | Auth, cart, checkout state               |
| `shared/validation/` | Truly shared validation primitives/infrastructure          | Feature form schemas                     |
| `shared/lib/`        | Configured third-party adapters and technical abstractions | Miscellaneous helpers                    |
| `shared/utils/`      | Small pure domain-neutral functions                        | React, stores, API clients, feature code |
| `shared/types/`      | Cross-cutting technical contracts                          | Feature entities and DTOs                |
| `shared/config/`     | Parsed runtime/build configuration                         | Feature constants                        |
| `shared/testing/`    | Generic renderers, factories, and matchers                 | Feature fixtures                         |

### 4.1 Promotion test

Promote code to `shared/` only when:

1. At least two independent modules need it.
2. They need identical semantics, not merely similar syntax.
3. It can be named without feature vocabulary.
4. It can evolve without coordinating with one feature owner.
5. It obeys `shared -X-> modules|app`.

Reuse count is evidence, not proof. Duplication is often cheaper than a premature abstraction.

Application-wide foundations may start in `shared/` before two consumers exist when their
scope is explicitly cross-cutting:

- design-system primitives;
- base HTTP/transport client;
- parsed runtime configuration;
- logging and monitoring adapters;
- generic application test renderer.

This exception never applies to speculative business abstractions.

### 4.2 Promotion ladder

```text
local file
  -> use-case folder
  -> module-level reusable code
  -> shared subdomain
  -> separate workspace package when independently reusable/versionable
```

Promote one level at a time and update consumers in the same change.

## 5. Module structure

Directories are allowed, not mandatory:

```text
src/modules/<module-name>/
├── README.md                # Purpose, flows, public API, dependencies
├── index.ts                 # Public API for app/other modules
├── api/                     # Requests, query options/hooks, DTO mapping
├── hooks/                   # Application orchestration hooks
├── store/                   # Client-state adapter
├── context/                 # React context adapters
├── schemas/                 # Schemas shared across internal boundaries
├── types/                   # Contracts not inferred from runtime schemas
├── utils/                   # Feature-local pure helpers and rules
├── config/                  # Feature constants/configuration
├── assets/                  # Feature media
├── i18n/                    # Feature messages
└── ui/
    ├── components/
    ├── forms/
    ├── sections/
    ├── modals/
    ├── layouts/
    └── views/
```

Create only directories that contain code. A module README is required when the module has
external consumers, two or more use cases, or a direct dependency on another module.

### 5.1 Small slice

```text
modules/profile/
├── index.ts
├── profile.schema.ts
├── use-profile.ts
└── profile-view.tsx
```

A small project may start with flat slices. An existing layered project may migrate one
feature at a time; do not require a big-bang move or empty directory scaffold.

### 5.2 Large slice

```text
modules/orders/
├── create-order/
├── order-history/
├── cancel-order/
└── index.ts
```

Internal use cases remain beneath their parent business capability and may co-locate their
UI, API adapter, schema, and tests.

## 6. Intra-module layers

```text
presentation (ui)
    -> application adapters (hooks/store/context)
        -> integration adapters (api)

presentation/application/integration
    -> domain foundation (schemas/types/utils/config)
```

- Lower layers must not import higher layers.
- Pure rules must not import React, browser storage, UI, or transport clients.
- UI may use a query/mutation hook directly when no orchestration is needed.
- Do not add pass-through hooks solely to satisfy the diagram.
- API code owns feature endpoints and DTO mapping; shared API owns transport.
- Do not mirror server state into a client store without an independent client-state need.

## 7. Public APIs and imports

- Default cross-module access uses `@/modules/<name>` through its root `index.ts`.
- Export the smallest stable surface; internal files are not public by default.
- Inside a module, use relative imports and never self-import through its public barrel.
- Across top-level boundaries, use configured aliases.
- Do not create a mega `src/shared/index.ts`; use explicit shared subpaths or focused barrels.
- Framework-specific extra public entrypoints belong only in the Architecture Profile.

## 8. UI ownership

```text
shared/ui/
├── primitives/             # Generated/local design-system source
├── patterns/               # Domain-neutral compositions
├── layouts/                # Reusable layout primitives
└── overlays/               # Generic confirm/prompt patterns
```

- Generic `Button` -> `shared/ui/primitives`.
- Generic `ConfirmDialog` -> `shared/ui/overlays`.
- `CheckoutAddressModal` -> `modules/checkout/ui/modals`.
- Route/navigation shell -> `app/layouts`.
- Feature layout -> its module's `ui/layouts`.

UI generator commands, aliases, registries, and resolved paths belong in the Architecture
Profile. Never hardcode a tool's default destination in this portable core.

## 9. Context variants

Dashboard/Webview, Web/Mobile, and similar splits are project-profile choices. Split at the
narrowest differing boundary:

```text
ui/views/
├── dashboard/
└── webview/
```

If context branching spreads through hooks, stores, API code, and UI, split the use case
instead of forcing every layer to remain context-agnostic.
