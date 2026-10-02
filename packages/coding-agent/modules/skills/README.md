# Skills

The CLI composes configuration, conventional roots, Skill scope/source metadata, and Tool
Permission. Platform-light Skill contracts, parsing, catalog construction, invocation, and
activation live in this module, including Node/Bun discovery and content loading.

## CLI composition API

- `discoverSkills({ configStore, homeRoot, workspace })` — load the shared config snapshot, build
  explicit root descriptors, then discover, validate, de-duplicate, and sort available Skills.
- `discoverSkillCatalog({ configStore, homeRoot, workspace }, decideSkill)` — build the
  permission-filtered catalog snapshot for one execution turn.
- `buildSkillRootDescriptors({ homeRoot, snapshot, workspace })` — map conventional and configured
  roots to deterministic `{ path, scope, source, precedence }` descriptors.
- `discoverSkillCandidates({ homeRoot, snapshot, workspace })` — return deterministic candidates through the merged module.

## Public Skills module API

- `parseSkillFile(source)` — parse frontmatter and body; throws `SkillValidationError` on invalid
  input.
- `SKILL_NAMESPACE_PREFIX` — the reserved namespace (`skill:`) a Skill row renders and its
  selection marker carries.
- `buildSkillCatalog(skills, decideSkill)` — filter denied Skills, validate hard limits, and build
  the catalog (including the 24 KiB tool-description budget and diagnostics).
- `buildSkillToolDefinition(catalog)` — the native `skill` tool definition sent to the model loop,
  or `undefined` when the catalog is empty or disabled.
- `createSkillExecution(catalog)` — the turn-scoped activation engine: at most three distinct
  Skills, idempotent re-loads, a rejected set, and structured `SKILL_LIMIT_REACHED` results.
- `createSkillSnapshot(skill, source)` — create a body-bearing, hashed request snapshot.
- `sanitizeSkillToolResult(result)` / `sanitizeSkillToolPart(part)` — collapse live activation
  data to safe metadata.
- Types: `Skill`, `SkillContext`, `SkillRequestContext`, `SkillCatalog`, `SkillExecution`,
  `SkillActivationSnapshot`, `SkillToolResult`, `SanitizedSkillToolResult`.

## Filesystem discovery API

- `discoverFilesystemSkillCandidates(roots)` / `discoverFilesystemSkills(roots)` — discover and load explicit root
  descriptors.
- `loadSkill(candidate)` / `loadSkills(candidates)` — load validated Skill bodies.
- `sampleSkillResources(baseDirectory)` — bounded, deterministic sample of bundled resource paths.

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

The root `/` suggestions always show Built-in and Custom Commands plus one `skill:` aggregate
when Skills are discoverable. Selecting the aggregate enters `/skill:` search; Skill results
fuzzy-match names only, both there and in nonempty bare slash queries. `/skill` shows
the namespace chooser rather than individual Skills. `/skills` is not a Built-in Command, but
follows the same bare-query matching behavior.
A `/` token inside prose opens the Skill list directly, without the namespace, and selecting an
individual Skill writes `/skill:<name> ` into the chat input in place of that token.

Only a selected row activates anything: typed or pasted `/skill:<name>` text stays ordinary
prompt text. A submission may carry several selected Skills; every selected marker is validated
and stripped from the prompt, and the leftmost selected Skill is the one activated. A selected
Skill that no longer exists rejects the submission instead of falling back. Enter selects a
matching row; when no command row matches, Enter submits the line normally.

## Skill Activation

A native `skill` tool is exposed to Primary Agents and Subagents whenever at least one local Skill
is not denied. Its description carries the permission-filtered `<available_skills>` catalog; the
Agent selects by exact name and the CLI executes the load — for local and hosted models alike.

- An explicitly selected Skill is resolved and authorized before the first model call and
  consumes one activation slot; rejection preserves the input and sends no prompt.
- An execution turn may activate at most three distinct Skills. Re-loading an active Skill is
  idempotent; rejected or failed loads consume no slot; a fourth distinct load returns a
  non-retryable `SKILL_LIMIT_REACHED` result.
- Skill bodies are snapshotted at activation and treated as untrusted, turn-scoped context. They
  are preserved through tool loops and compaction until the turn ends, then discarded. Durable
  history stores only sanitized activation metadata (name, content hash, source).
- Bundled references, templates, and scripts resolve from the Skill directory; the tool result
  samples up to ten absolute resource paths. Resources outside the workspace require
  `external_directory` permission in addition to the underlying operation permission.
- Skill access is governed by the `skill` Permission action (default `allow`, with
  allow/ask/deny and Skill-name globs); `external_directory` defaults to `ask`.
