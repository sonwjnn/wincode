# Commands

Slash-command registry and dispatch for the CLI chat input.

## Flows

1. **Registration** — `CommandSpec` is a discriminated union of 10 commands kept in
   `COMMANDS[]`. Each spec carries a `value` (`/new`, `/exit`, …), a display name, a
   description, and a `kind` discriminator.
2. **Filter** — `getFilteredCommands` fuzzy-matches specs against the user's `/` query in
   the chat input overlay.
3. **Dispatch** — `createCommandExecutor` receives an `AdapterMap` at app bootstrap and
   returns a function that switches on `spec.kind`, delegating to the matching adapter.
4. **Adapters** — each adapter class captures a side‑effect contract:
   - `ExitAdapter` → `renderer.destroy()`
   - `NewAdapter` → TanStack Router navigation
   - `DialogAdapter` → opens sessions / theme dialogs
   - `ModelsAdapter` / `VariantsAdapter` / `ModeAdapter` → open model‑picker /
     variant‑picker / agent‑picker dialogs
   - `UnavailableAdapter` → toast notification
5. **Overlay** — `CommandMenu` renders the matched suggestions below the input. Arrow keys
   highlight, Enter executes.

## Public API

- `COMMANDS`, `CommandSpec`
- `getFilteredCommands(query)`
- `createCommandExecutor(adapters)`, `AdapterMap`
- `CommandMenu`
- Adapter classes: `ExitAdapter`, `NewAdapter`, `DialogAdapter`, `ModelsAdapter`,
  `VariantsAdapter`, `ModeAdapter`, `UnavailableAdapter`

## Dependencies

- No sibling-module imports. Adapters receive their concrete deps (router, dialog, theme,
  toast) from `app/` composition in `use-app-command-executor`.
- `shared/terminal/theme` — terminal colour context (command‑menu overlay)
