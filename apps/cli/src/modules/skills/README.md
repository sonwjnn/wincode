# Skills

Skill discovery, validation, loading, slash-invocation parsing, and Agent-driven
Skill Activation. No UI or conversation persistence; activation state lives per
execution turn.

## Public API

- `discoverSkills({ configStore, homeRoot, workspace })` — load the shared config snapshot, then
  discover, validate, de-duplicate, and sort available skills (with a parsed-file cache keyed by
  path and file metadata).
- `discoverSkillCatalog({ configStore, homeRoot, workspace }, decideSkill)` — build the
  permission-filtered catalog snapshot for one execution turn.
- `discoverSkillCandidates({ homeRoot, snapshot, workspace })` — return deterministic `SKILL.md`
  candidates.
- `loadSkill(candidate)` / `loadSkills(candidates)` — load validated skill bodies.
- `parseSkillFile(source)` — parse frontmatter and body; throws `SkillValidationError` on invalid
  input.
- `parseSkillInvocation(input)` — parse `/skill-name arguments` into `{ name, arguments }`, or
  return `null`.
- `buildSkillCatalog(skills, decideSkill)` — filter denied Skills, validate hard limits, and build
  the catalog (including the 24 KiB tool-description budget and diagnostics).
- `buildSkillToolDefinition(catalog)` — the native `skill` tool definition sent to the model loop,
  or `undefined` when the catalog is empty or disabled.
- `createSkillExecution(catalog)` — the turn-scoped activation engine: at most three distinct
  Skills, idempotent re-loads, a rejected set, and structured `SKILL_LIMIT_REACHED` results.
- `sampleSkillResources(baseDirectory)` — bounded, deterministic sample of bundled resource paths.
- `sanitizeSkillToolResult(result)` — collapse a live tool result to activation metadata.
- Types: `Skill`, `SkillCandidate`, `SkillFrontmatter`, `SkillInvocation`, `SkillCatalog`,
  `SkillExecution`, `SkillActivationSnapshot`, `SkillToolResult`, `SanitizedSkillToolResult`.

## Discovery and precedence

Wincode sources are global `${XDG_CONFIG_HOME:-~/.config}/wincode/skills` and
`~/.wincode/skills`, project `.wincode/skills` directories while walking from the Git worktree root
to the workspace, and optional `skills.paths` entries from Wincode JSON. Legacy compatibility
sources remain global `~/.agents/skills`, `~/.claude/skills`, `~/.opencode/skills`, and
`~/.config/opencode/skills`, plus project `.agents/skills`, `.claude/skills`, and `.opencode/skills`
at each traversed root.

Project skills override global skills. A nearer project ancestor overrides a farther one. Within a
scope, Wincode folders override legacy folders, configured paths override conventional folders,
the home Wincode folder overrides the XDG Wincode folder, and a later configured path overrides an
earlier one. Invalid or unreadable candidates are skipped. Discovered files are local filesystem
input and are trusted only as explicitly configured by the user; skill bodies are sent with the
current request when selected.

## Configured paths

```json
{
	"skills": {
		"paths": ["./skills", "/absolute/shared/skills"]
	}
}
```

Each path names a directory whose direct child directories may contain `SKILL.md`. Relative paths
resolve from the directory containing the `wincode.json` or `wincode.jsonc` source that supplied the
array; absolute paths remain absolute. Shared config merge rules apply, so a higher-precedence
`paths` array replaces a lower one. Conventional Wincode and retained legacy folders always
participate alongside the configured list.

## `SKILL.md`

Each skill is a directory containing `SKILL.md`. YAML frontmatter requires:

- `name`: lowercase alphanumeric words separated by single hyphens, 1–64 characters, matching the
  containing directory name.
- `description`: 1–1024 characters.

The remaining file content is the skill body.

## Invocation and transport

`/skills` opens the picker. Selecting a skill creates a request-scoped skill invocation;
`/skill-name arguments` parses the named skill and raw arguments for that request. The selected
skill body and arguments propagate through both local and hosted chat execution paths.

## Skill Activation

A native `skill` tool is exposed to Primary Agents and Subagents whenever at least one local Skill
is not denied. Its description carries the permission-filtered `<available_skills>` catalog; the
Agent selects by exact name and the CLI executes the load — for local and hosted models alike.

- Explicit `/skill-name arguments` is resolved and authorized before the first model call and
  consumes one activation slot; rejection preserves the input and sends no prompt.
- An execution turn may activate at most three distinct Skills. Re-loading an active Skill is
  idempotent; rejected or failed loads consume no slot; a fourth distinct load returns a
  non-retryable `SKILL_LIMIT_REACHED` result.
- Skill bodies are snapshotted at activation and treated as untrusted, turn-scoped context. They
  are preserved through tool loops and compaction until the turn ends, then discarded. Durable
  history stores only sanitized activation metadata (name, content hash, source, arguments).
- Bundled references, templates, and scripts resolve from the Skill directory; the tool result
  samples up to ten absolute resource paths. Resources outside the workspace require
  `external_directory` permission in addition to the underlying operation permission.
- Skill access is governed by the `skill` Permission action (default `allow`, with
  allow/ask/deny and Skill-name globs); `external_directory` defaults to `ask`.
