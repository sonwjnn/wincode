# Commands

Slash-command registry and dispatch for the CLI chat input.

## Flows

1. **Registration** — `COMMANDS[]` gives each Built-in Command a slash value,
   display name, description, and namespaced action ID (`session.new`,
   `dialog.sessions`, …), and an input capability. `none` rejects arguments;
   `optional-text` passes the entered text to its action handler. `/compact`
   declares optional text named `focus` and requires the `compaction` capability.
   Commands declare row requirements as capabilities; views pass unavailable
   capabilities to hide those rows without action-specific filter flags.
2. **Items** — `CommandController` builds the `/` overlay from Built-in Commands
   and Custom Commands, adding one `skill:` aggregate when Skills are discoverable.
   At the start of an empty prompt (`root` scope) the aggregate comes first, and
   nonempty bare queries also fuzzy-match Skill names. On a `/` token inside prose
   (`skill` scope) the overlay offers Skills only, matched by name, so a Skill can
   be selected anywhere in the prompt without the `skill:` namespace. `/skill`
   (the namespace chooser) is excluded; `/skills` has no built-in command of its own
   but may fuzzy-match Skill rows like any other bare query.
3. **Interaction** — `createCommandController` owns suggestion discovery and
   filtering, selection rules, and prompt resolution. Selecting a row returns an
   insert with the invocation and, for Skills, Custom Commands, and text-accepting
   Built-in Commands, a `CommandSelectionIntent`. Typed or pasted text never turns
   into a command: only the input controller's tracked selections carry intent into
   `prepareSubmission`. The input controller receives only the `CommandController`
   interface and applies its selection and submission plans.
4. **Execution strategies** — `tui/commands/command-controller-provider.tsx`
	loads Custom Commands and Skills, then binds TUI dependencies to the strategy
	registry in `tui/commands/command-strategies.ts`. Each Built-in action has one
	strategy: `dialog` opens content immediately, `prepared-dialog` awaits
	external data first, and `action` performs a side effect. The dialog
	strategies share presentation metadata through `openCommandDialog`. Adding a
	Built-in Command requires a `COMMANDS` row and one strategy entry; TypeScript
	checks that every action has one. Handler signatures and strategy argument
	types derive from each command's input capability. Hidden Built-in rows cannot
	be selected, so they cannot run in a view that hides them.
5. **Overlay** — `SelectableList` renders matched suggestions below the input. Arrow keys
   highlight. Tab executes Built-in Commands whose input capability is `none`; it completes
   Built-in Commands accepting text, Custom Commands, and Skills into the composer with a
   trailing space, tracking the completion as a selection. Enter enters Skill search from the
   aggregate, executes Built-in Commands, or inserts Custom Commands and Skills. Escape
   closes the command overlay without editing the composer text. With no command match,
   Enter submits the prompt normally.

## Public API

- `COMMANDS`, `COMMAND_CAPABILITIES`, `CommandActionId`, `CommandCapability`,
  `CommandSpec`, `getVisibleCommands(options)`
- `CommandController`, `CommandControllerFactory`, `createCommandController`
  (`command-controller.ts`)
- `CommandControllerFactoryProvider`, `useCommandControllerFactory`
  (`command-controller-context.ts`)
- `CommandItem`, `getCommandLabel`, `getCommandInvocation`, `createSkillCommandSpecs`,
- `createSkillSearchCommandSpec`, `filterCommandItems` (`command-item.ts`)
- `CommandSuggestionScope`, `CommandSelectionIntent`, `CommandSubmissionInput`
  (`command-controller.ts`)
- `createCommandExecutor(handlers)`, `CommandHandlerMap`
- `SubmissionIntent`, `resolveSubmissionPrompt` (`submission-resolution.ts`)

## Dependencies

- `modules/commands/custom/types` — the Custom Command spec that joins the item union.
- `@/modules/skills` — the reserved `skill:` namespace and the Skill row label.
- `modules/sessions/hooks/input-controller` — depends on `CommandController`;
  slash-command matching and selection stay inside this module.
- TUI command composition lives in `tui/commands`; sessions consume only the
  `CommandController` interface through the factory context declared by this
  module.
- `shared/ui/selectable-list` — shared OpenTUI selection surface used by command
  and file-mention menus.
