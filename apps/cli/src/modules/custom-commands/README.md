# Custom Commands

User-defined prompt templates loaded from command folders and offered alongside
Built-in Commands in the `/` overlay.

## Flows

1. **Discovery** — `discoverCustomCommandCandidates` scans `~/.wincode/commands/`
   (global) and `.wincode/commands/` (project, walked from CWD to the Git root).
   Only direct `.md` children are candidates; subfolders are ignored.
2. **Load** — `loadCustomCommands` parses each file (YAML frontmatter with an
   optional `description`; the body is the template), deduplicates by name with
   project winning over global, and drops commands that collide with Built-in
   Commands. Invalid files are skipped best-effort.
3. **Filter** — `filterCustomCommands` prefix-matches the command name against
   the first token of the `/` query, so `test Button` still selects `test`.
4. **Expand** — `expandCustomCommandTemplate` substitutes `$ARGUMENTS`,
   `$1..$n` (positional, split on whitespace), and `$$` (literal dollar).
   Unknown `$TOKENS` are left untouched. `extractArguments` pulls the text
   after the command name from a `/` query.
5. **Execute** — selecting a custom command in the input controller replaces
   the textarea with the expanded template; the user reviews before sending.
   There is no adapter dispatch for custom commands.

## Public API

- `getCustomCommands(cwd?, home?)` (`loader.ts`) — full discovery + load pipeline
- `discoverCustomCommandCandidates` (`discovery.ts`), `loadCustomCommands`
  (`loader.ts`)
- `parseCustomCommandFile`, `CustomCommandValidationError` (`parse.ts`)
- `expandCustomCommandTemplate`, `extractArguments` (`expand.ts`)
- `filterCustomCommands` (`filter.ts`)
- Types: `CustomCommandSpec`, `CustomCommandCandidate` (`types.ts`)

## Dependencies

- `modules/commands` — consumes the Built-in Command registry to enforce that
  built-ins win name collisions.
- No runtime imports from this module back into other modules.
