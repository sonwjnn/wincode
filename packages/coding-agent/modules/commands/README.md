# Commands

Slash-command registry and dispatch for the CLI chat input.

## Flows

1. **Registration** — `CommandSpec` is a discriminated union of commands kept in
   `COMMANDS[]`. Each spec carries a `value` (`/new`, `/exit`, …), a display name, a
   description, and a `kind` discriminator.
2. **Items** — `command-item.ts` builds the `/` overlay from Built-in Commands and
   Custom Commands, adding one `skill:` aggregate when Skills are discoverable.
   Selecting the aggregate enters `/skill:` search. Skills fuzzy-match names and
   descriptions in that namespace search and in nonempty bare slash queries. `/skill`
   (the namespace chooser) is excluded; `/skills` has no built-in command of its own
   but may fuzzy-match Skill rows like any other bare query.
3. **Dispatch** — `createCommandExecutor` receives an `AdapterMap` at app bootstrap and
   returns a function that switches on `spec.kind`, delegating to the matching adapter.
   The same executor serves overlay selection and typed Built-in Commands
   (`findBuiltinCommand` in the input controller).
4. **Adapters** — each adapter class captures a side‑effect contract:
  - `ExitAdapter` → `renderer.destroy()`
  - `NewAdapter` → TanStack Router navigation
  - `DialogAdapter` → opens sessions / theme dialogs
  - `ModelsAdapter` / `EffortAdapter` / `AgentsAdapter` → open model-picker /
    Effort-and-Reasoning-Mode / agent-picker dialogs
5. **Overlay** — `SelectableList` renders matched suggestions below the input. Arrow keys
   highlight. Tab executes Built-in Commands with no invocation arguments; it completes `/compact`
   (which accepts optional focus text), Custom Commands, and Skills into the composer with a
   trailing space. Enter enters Skill search from the aggregate, executes Built-in Commands, or
   inserts Custom Commands and Skills. With no command match, Enter submits the prompt normally.

## Public API

- `COMMANDS`, `CommandSpec`, `getVisibleCommands(options)`
- `CommandItem`, `getCommandLabel`, `getCommandInvocation`, `createSkillCommandSpecs`,
- `createSkillSearchCommandSpec`, `filterCommandItems` (`command-item.ts`)
- `createCommandExecutor(adapters)`, `AdapterMap`
- Adapter classes: `ExitAdapter`, `ConnectAdapter`, `DialogAdapter`, `ModelsAdapter`,
  `EffortAdapter`, `AgentsAdapter`, `SettingsAdapter`

## Dependencies

- `modules/custom-commands/types` — the Custom Command spec that joins the item union.
- `@/modules/skills` — the reserved `skill:` namespace and the Skill row label.
- Adapters receive their concrete deps (router, dialog, theme, toast) from `tui/`
  composition in `use-command-executor`.
- `shared/ui/selectable-list` — shared OpenTUI selection surface used by command
  and file-mention menus.
