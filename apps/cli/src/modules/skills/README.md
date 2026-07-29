# Skills

Pure skill discovery, validation, loading, and slash-invocation parsing. No UI, context, or
conversation persistence.

## Public API

- `discoverSkills()` — discover, validate, load, de-duplicate, and sort available skills.
- `discoverSkillCandidates(cwd?, home?)` — return deterministic `SKILL.md` candidates.
- `loadSkill(candidate)` / `loadSkills(candidates)` — load validated skill bodies.
- `parseSkillFile(source)` — parse frontmatter and body; throws `SkillValidationError` on invalid
  input.
- `parseSkillInvocation(input)` — parse `/skill-name arguments` into `{ name, arguments }`, or
  return `null`.
- Types: `Skill`, `SkillCandidate`, `SkillFrontmatter`, `SkillInvocation`.

## Discovery and precedence

OpenCode-compatible sources are global `~/.agents/skills`, `~/.claude/skills`, and exactly
`~/.config/opencode/skills`, plus project `.agents/skills`, `.claude/skills`, and
`.opencode/skills` directories while walking from CWD to the Git worktree root. Project skills
override global skills. A nearer project ancestor overrides a farther one; within one root,
`.opencode` overrides `.claude`, which overrides `.agents`; ties use deterministic path ordering.
Invalid or unreadable candidates are skipped. Discovered files are local filesystem input and are
trusted only as explicitly configured by the user; skill bodies are sent with the current request
when selected.

## `SKILL.md`

Each skill is a directory containing `SKILL.md`. YAML frontmatter requires:

- `name`: lowercase alphanumeric words separated by single hyphens, 1–64 characters, matching the
  containing directory name.
- `description`: 1–1024 characters.

The remaining file content is the skill body.

## Invocation and transport

`/skills` opens the picker. Selecting a skill creates a request-scoped skill invocation;
`/skill-name arguments` parses the named skill and raw arguments for that request. The selected
skill body and arguments propagate through both local and hosted chat execution paths. Skills are
not stored in conversation/session history and have no session persistence.
