# CLI Architecture Profile

## Project configuration

- Framework/rendering: `OpenTUI React (Bun runtime)`
- Source alias: `none`
- Slice root/name: `src/modules`
- Rendering contexts: `terminal`
- Server state: `AI SDK useChat hook (no TanStack Query)`
- Client state: `React Context (Theme, PromptConfig, Dialog stack, KeyboardLayer, Toast)`
- Runtime validation: `Zod`
- UI system: `OpenTUI (terminal-native elements: box, text, input, textarea, scrollbox, spinner, ascii-font)`
- UI generator/registry/destination: `not applicable`
- Global styles/theme location: `src/shared/terminal/theme/themes.ts`
- Localization infrastructure: `none`
- Generated-code paths and regeneration commands:
  - `src/routeTree.gen.ts` — regenerated with: `bun x tsr generate` from `apps/cli/`
  - Config: `tsr.config.json`
- Bootstrap injections: `env.SERVER_URL → Hono client created once in shared/api/hono-client.ts`
- Error model: `throw unexpected failures; no typed result wrapper`
- Test placement: `co-located`

## Module → CLI mapping

Frontend terms map to CLI concerns:

| Frontend term | CLI mapping |
| ------------- | ----------- |
| `ui/`          | terminal presentation: box/text/input/textarea components, command overlays |
| `hooks/`      | application orchestration hooks: chat state, input controller |
| `context/`    | React Context for app/module state such as PromptConfig |
| `utils/`      | pure feature helpers and rules such as file mention grammar |
| `api/`         | Hono RPC adapters: session CRUD, chat request construction, error parsing |
| `app/`         | CLI bootstrap, TanStack Router file routes, provider composition, command executor wiring |
| `shared/`      | terminal-only infrastructure: theme, dialog, toast, keyboard layer, searchable list, border chars |

## Public entrypoints

- Default: `index.ts` only.

## Verification commands

- Format: `bun x ultracite fix`
- Lint: `bun run check` (root)
- Typecheck: `bun run --cwd apps/cli check-types`
- Unit/integration tests: `bun test apps/cli/src`
- Build: `none (Bun runs TypeScript natively)`
- Architecture check: `none (manual review)`
- Cycle check: `none (manual review)`

## Approved exceptions

- None.

## Route generation

- Routes directory: `src/app/routes/`
- Generated tree: `src/routeTree.gen.ts`
- Config: `apps/cli/tsr.config.json`
- Command: `bun x tsr generate` from `apps/cli/`
- Do not edit `routeTree.gen.ts` manually. Excluded from Biome formatting per root `biome.json`.
