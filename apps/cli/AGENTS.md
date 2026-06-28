# CLI App

Read root `AGENTS.md` first. This file adds CLI-specific scope.

## Required context

- Always read `docs/architecture-profiles/cli.md`.
- Invoke OpenTUI skill (`opentui`) for terminal UI patterns, components, and keyboard handling.
- Read `docs/architecture.md` when adding/moving modules, changing imports, or touching
  `src/shared/`.
- Read `docs/coding-standards.md` when adding schemas, tests, assets, generated code, or
  changing naming/error behavior.
- Read `docs/refactoring-playbook.md` for migrations and structural refactors.
- Read `docs/adr/README.md` before adding an exception to these rules.

## CLI-specific mapping

Frontend terms in core architecture docs map to CLI:

| Term | CLI meaning |
| ---- | ----------- |
| `ui/` | command presentation: terminal box/text/input/textarea components, overlays, output formatters |
| `ui/views` | top-level screen components (chat screen, home screen) |
| `ui/components` | reusable terminal widgets (chat shell, chat text area, spinner) |
| `hooks/` | application orchestration hooks: chat state, input controller |
| `context/` | React Context for app/module state such as PromptConfig (no Zustand/Redux) |
| `utils/` | pure feature helpers and rules such as file mention grammar |
| `api/` | Hono RPC adapters: session CRUD, chat request builder, error response parsing |
| `app/` | CLI bootstrap, TanStack Router file routes, provider composition, command executor DI |
| `shared/` | terminal-only utilities with no feature knowledge: theme, dialog, toast, keyboard layer, searchable list, border chars |

## Verification

- Typecheck: `bun run --cwd apps/cli check-types`
- Tests: `bun test apps/cli/src`
- Lint: `bun run check` (root)
- Route regen: `bun x tsr generate` (from `apps/cli/`)

## Non-negotiable invariants

1. Organize product code by business capability under `src/modules/<module>/`.
2. A module owns its UI, behavior, state, API integration, schemas, tests, messages, and assets.
3. The first meaningful names under `src/modules/` are business names, not technical layers.
4. `src/app/` composes routes, providers, layouts, and modules; it does not own feature rules.
5. `src/shared/` contains only domain-neutral, cross-module infrastructure or abstractions.
6. Dependencies flow `app -> modules -> shared`; reverse imports are forbidden.
7. Cross-module access uses only the target module's declared public API.
8. Circular module dependencies are forbidden.
9. Start with co-located files. Add internal layers or sub-slices only when complexity requires it.
10. Do not create empty folders or promote speculative abstractions.

## Vertical-slice preservation test

A normal change to one capability should be understandable and mostly implementable by opening
one module. If a feature routinely requires parallel edits across app-wide `components/`,
`hooks/`, `services/`, `stores/`, and `types/` folders, stop: the code has drifted away from
vertical slices.

## Before editing

1. Identify the owning business capability and use case.
2. Inspect the module public API and consumers.
3. Classify each touched item as app composition, module-owned, or genuinely shared.
4. Check for deep imports, reverse dependencies, and cycles.
5. Use the smallest structure that supports the requested behavior.

## Before finishing

- [ ] Feature code remains co-located in its owning module.
- [ ] No `shared -> modules|app` or `modules -> app` import exists.
- [ ] Cross-module imports use declared public APIs.
- [ ] No cycle, speculative folder, or premature shared abstraction was introduced.
- [ ] Public APIs and required module README files are current.
- [ ] All verification commands from the Architecture Profile pass.
- [ ] Report ownership decisions, API changes, exceptions, and verification results.
