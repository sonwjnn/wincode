# Architecture Profiles

This file dispatches to app-specific profiles. It does not contain project data.

Core architecture rules live in:

- `docs/architecture.md` — vertical slices, layers, dependency direction, module structure
- `docs/coding-standards.md` — naming, schemas, errors, tests, assets
- `docs/refactoring-playbook.md` — migration process, boundary repair, verification

## App profiles

Each app has a dedicated profile under `docs/architecture-profiles/`:

| App | Profile | Description |
| --- | ------- | ----------- |
| `apps/cli` | `docs/architecture-profiles/cli.md` | OpenTUI React terminal app, Hono API client, TanStack Router |
| `apps/web` | `docs/architecture-profiles/web.md` | TanStack Start SPA, tRPC, shadcn/ui, Cloudflare Workers |

Do not add profile data here. Open the matching profile for the app you are editing.
