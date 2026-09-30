# Commands

Slash-command registry and dispatch for the CLI chat input.

## Flows

1. **Registration** — `COMMANDS[]` gives each Built-in Command a slash value,
   display name, description, and namespaced action ID (`session.new`,
   `dialog.sessions`, …). `CommandSpec` marks these rows as `builtin`; `/compact`
   may also carry focus text when invoked from the input.
2. **Items** — `command-item.ts` builds the `/` overlay from Built-in Commands and
   Custom Commands, adding one `skill:` aggregate when Skills are discoverable.
   Selecting the aggregate enters `/skill:` search. Skills fuzzy-match names and
   descriptions in that namespace search and in nonempty bare slash queries. `/skill`
   (the namespace chooser) is excluded; `/skills` has no built-in command of its own
   but may fuzzy-match Skill rows like any other bare query.
3. **Dispatch** — `createCommandExecutor` receives a complete, typed
   `CommandHandlerMap` keyed by action ID. It forwards `/compact` focus to its
   handler. The same executor serves overlay selection and typed Built-in
   Commands (`findBuiltinCommand` in the input controller).
4. **Handlers** — `tui/commands/handlers/` groups application, session, and
   selection actions. `useCommandExecutor` composes these groups from TUI
   dependencies and maps failures to an error toast. Hidden Built-in rows remain
   callable by typing; unavailable actions report an error.
5. **Overlay** — `SelectableList` renders matched suggestions below the input. Arrow keys
   highlight. Tab executes Built-in Commands with no invocation arguments; it completes `/compact`
   (which accepts optional focus text), Custom Commands, and Skills into the composer with a
   trailing space. Enter enters Skill search from the aggregate, executes Built-in Commands, or
   inserts Custom Commands and Skills. With no command match, Enter submits the prompt normally.

## Public API

- `COMMANDS`, `CommandActionId`, `CommandSpec`, `getVisibleCommands(options)`
- `CommandItem`, `getCommandLabel`, `getCommandInvocation`, `createSkillCommandSpecs`,
- `createSkillSearchCommandSpec`, `filterCommandItems` (`command-item.ts`)
- `createCommandExecutor(handlers)`, `CommandHandlerMap`

## Dependencies

- `modules/commands/custom/types` — the Custom Command spec that joins the item union.
- `@/modules/skills` — the reserved `skill:` namespace and the Skill row label.
- TUI handlers receive their concrete dependencies (router, dialog, theme, toast)
  from `use-command-executor`.
- `shared/ui/selectable-list` — shared OpenTUI selection surface used by command
  and file-mention menus.
