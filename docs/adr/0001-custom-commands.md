# Custom Commands

Custom Commands are user-defined prompt templates loaded from `~/.wincode/commands/`
(global) and `.wincode/commands/` (project), defined as markdown files with YAML
frontmatter (`description`) and a template body; project commands win over global
commands on name collisions, and Built-in Commands always win over Custom Commands
with the same name.

Status: accepted

## Considered Options

- **Markdown + frontmatter over JSON** — mirrors opencode's battle-tested format,
  so existing command files (e.g. Matt Pocock skills) migrate by copying. Frontmatter
  fields wincode does not understand (agent, model) are ignored, fail-open.
- **`commands/` over `command/`** — plural matches opencode conventions even though
  `~/.wincode` is a private namespace.
- **Built-in wins over custom** — deliberately opposite to opencode, where custom
  commands override built-ins. Wincode's built-ins are UI actions dispatched to
  adapters (`/exit`, `/new`); letting a template shadow them would surprise users.
  Colliding custom commands are ignored with a warning.
- **Project wins over global** — mirrors project-config-overrides-global and the
  existing `.wincode/mcp.json` policy precedence.
- **No opencode directories** — wincode does not read `~/.config/opencode/commands/`
  or `~/.opencode/...`; `~/.wincode` is its own namespace. The MCP module's
  remaining read of `~/.config/opencode/opencode.json` is a fork leftover, not a
  pattern to copy.
- **Insert the invocation, expand at submit, not into the textarea** — selecting a
  custom command inserts `/<name> ` into the textarea; on submit the template is
  expanded into the sent prompt while history keeps the visible invocation.
  Mirrors the existing skills flow (`resolveSkillPrompt`) instead of opencode's
  paste-the-template behaviour. If the text matches a skill and a custom
  command, the skill wins. Arguments are typed after selection and parsed from
  the submitted invocation; the slash trigger ignores text after whitespace, so
  the command overlay never re-opens while typing arguments.
- **Global and project scopes now, not deferred** — both from day one; only the
  global scope was initially planned.

## Consequences

- v1 supports `$ARGUMENTS`, `$1..$n`, and `$$` escape only; shell injection
  (!\`cmd\`) and file references (`@file`) are deferred — they add a new security
  surface that needs its own design.
- Commands are scanned lazily each time the `/` menu opens; no watcher or startup
  cache.
- Only `.md` files are read; subfolders are ignored (filename = command name).
