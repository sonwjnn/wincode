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
   the `/` query (queries cannot carry arguments; the slash trigger ignores
   text after whitespace).
4. **Expand** — `expandCustomCommandTemplate` substitutes `$ARGUMENTS`,
   `$1..$n` (positional, split on whitespace), and `$$` (literal dollar).
   Unknown `$TOKENS` are left untouched. Arguments come from the invocation
   parsed from the submitted prompt.
5. **Invoke** — `parseCustomCommandInvocation` parses `/name args` from the
   submitted prompt text.
6. **Execute** — selecting a custom command in the input controller inserts
   `/<name> ` into the textarea. On submit the template is expanded into the
   sent prompt, mirroring the skills flow; the visible invocation stays in
   history. If a skill and a custom command both match the text, the skill
   wins. There is no adapter dispatch for custom commands.

## Public API

- `getCustomCommands(cwd?, home?)` (`loader.ts`) — full discovery + load pipeline
- `discoverCustomCommandCandidates` (`discovery.ts`), `loadCustomCommands`
  (`loader.ts`)
- `parseCustomCommandFile`, `CustomCommandValidationError` (`parse.ts`)
- `parseCustomCommandInvocation`, `CustomCommandInvocation` (`invocation.ts`)
- `expandCustomCommandTemplate` (`expand.ts`)
- `filterCustomCommands` (`filter.ts`)
- Types: `CustomCommandSpec`, `CustomCommandCandidate` (`types.ts`)

## Dependencies

- `modules/commands` — consumes the Built-in Command registry to enforce that
  built-ins win name collisions.
- No runtime imports from this module back into other modules.
