# Agent definitions via Wincode JSON/JSONC configuration — research note

| | |
|---|---|
| Research date | 2026-08-09 |
| Repository HEAD | `4d97105` refactor: remove redundant aliases |
| Relevant commits | `03b9bb5` feat(cli): load commands and skills from Wincode config; `e3afe8e` feat(cli)!: add shared Wincode config store; `8ccd853` feat(commands): add custom commands from `.wincode/commands` folders; `f77efd3` test(cli): exercise config store with real files |
| Scope | Research only — no implementation code was changed |

> **Status: superseded.** The migration this note researched has been completed.
> The closed `ModeType` / `codingModes` Coding Mode contract was removed from
> `packages/ai`, the CLI, and the hosted API; the canonical selection is the
> `AgentId` / resolved `Agent` runtime. Conversation persistence now uses
> Wincode Conversation Records, and no compatibility normalizer remains.
> References below describe the pre-migration state and are intentionally
> historical.

---

## Executive summary

Wincode already has a domain-neutral, provenance-aware config store (`apps/cli/src/shared/config/config-store.ts`, added in `e3afe8e`) that loads `wincode.json` / `wincode.jsonc` from four locations, merges them, and exposes per-path provenance. Commit `03b9bb5` established the exact pattern for wiring a new capability onto that store: a per-module `discovery.ts` that reads a capability section (`commands.paths`, `skills.paths`) off `snapshot.document`, resolves relative entries through `resolveConfigRelativePath` + `getProjectRoots`, and a loader that dedupes by name with defined precedence. The shared-config README explicitly reserves a slot for this: *"MCP, commands, agents, skills, and future capabilities resolve their own sections from the raw snapshot"* (`apps/cli/src/shared/config/README.md:21-22`).

The smallest clean seam for `agents` support is therefore:

1. A new `apps/cli/src/modules/agents/` module (discovery → loader → types → index), mirroring `modules/skills/` and `modules/custom-commands/`, consuming `ConfigRuntime` (`config-store.ts:36-40`).
2. A widening of the closed `ModeType` / `codingModeNameSchema` union in `packages/ai/src/modes.ts:13-38` plus the mode-keyed instruction/tool lookups (`packages/ai/src/instructions.ts`, `packages/ai/src/server/agent.ts:43-62`) — this is the real coupling point, because "agents" today are exactly the two hard-coded `codingModes` surfaced in the `/agents` dialog.
3. A decision about the config shape — the repo's own precedent (`{ commands: { paths } }`) is a path array, while upstream OpenCode uses a named record (`agents: { <name>: {...} }`). These are not compatible, and choosing is the primary unresolved product decision.

The hardest constraint is the hosted path: `apps/server/src/routes/sessions.ts` validates `mode` against the same closed enum and derives billing costs from the built-in mode prompts; custom agents are client-side concepts that the server cannot know about without a contract change or a strict client-side-only model.

---

## 1. Current config pipeline

### 1.1 Entrypoints and filenames

- `apps/cli/src/shared/config/config-store.ts:406-434` — `createConfigStore()` is the single entrypoint. Defaults: `homeRoot = homedir()`, `configRoot = ${XDG_CONFIG_HOME:-~/.config}/wincode` (lines 409-418); default fs is `Bun.file().text()` (419-421).
- `loadSnapshot` (lines 361-404) reads four locations, lowest to highest precedence:
  1. `configRoot` (`${XDG_CONFIG_HOME:-~/.config}/wincode`) — scope `global`
  2. `~/.wincode` — scope `global`
  3. `<workspace>` — scope `project`
  4. `<workspace>/.wincode` — scope `project`
- Per location, `selectConfigFile` (270-295) checks `wincode.jsonc` first; JSONC wins over JSON, and a sibling `wincode.json` produces a `duplicate-config` diagnostic (`selectJsoncFile`, 239-268).
- `getSnapshot(workspace)` (424-434) memoizes one promise per resolved workspace path; snapshots are deeply frozen (99-113, 381-403).

### 1.2 Parsing and safety

- `parseDocument` (297-336) parses with `jsonc-parser` (`parseTree` + `parse`, `allowTrailingComma: true`) — trailing commas and comments (JSONC) are supported.
- Malformed documents are isolated per source with a `parse-error` diagnostic; the rest of the snapshot still merges (313-322).
- `findUnsafeKey` (68-83) rejects `__proto__` / `constructor` / `prototype` at any depth via `unsafe-key` diagnostic.
- `cloneValue` (85-97) rebuilds parsed objects with `Object.create(null)` prototypes — no prototype pollution.
- Diagnostics: `ConfigDiagnostic` (19-26) with codes `duplicate-config | parse-error | read-error | unsafe-key`, each carrying `path` + `scope` (the module-level `ConfigOrigin`).

### 1.3 Merge and provenance

- `mergeDocument` (161-180): objects merge recursively; **arrays and scalars replace** earlier values (arrays are *not* concatenated across layers — see `config-store.test.ts:187` "does not resurrect lower object fields after a scalar replacement").
- `recordProvenance` (136-159) records which source contributed every key (including array indices, so `["skills","paths","0"]` resolves).
- `snapshot.sourceFor(pathSegments)` (394-401) returns the originating `ConfigOrigin` for the longest matching prefix — this is what makes per-capability diagnostics and relative path resolution possible.
- `sources` (31) keeps each raw source document, so capability modules can also scan per-source content (Skills discovery does this for sibling `skills` dirs — `apps/cli/src/modules/skills/discovery.ts:84-92`).

### 1.4 Runtime wiring

- `apps/cli/src/shared/config/config-provider.tsx` — `ConfigProvider` / `useConfig()` React context exposing `ConfigRuntime` (`config-store.ts:36-40`: `{ configStore, homeRoot, workspace }`).
- `apps/cli/src/app/layouts/root-layout.tsx:20-29` — one process-lifetime `createConfigStore()` + frozen `configContext` composed at module scope; injected via `ConfigProvider` (line 67) and into `createMcpRegistry({ configStore, workspace })` (line 29).

### 1.5 Schema, validation, diagnostics

There is **no central JSON schema**; the store is deliberately schema-less (`README.md:21-23`). Each capability validates its own section with zod and reports diagnostics attributed to provenance:

- MCP is the reference implementation: `apps/cli/src/modules/mcp/config/schema.ts` (zod schemas, `.strict()`), `apps/cli/src/modules/mcp/config/resolve.ts` — `resolveServers` (289-330), per-source malformed-entry scanning (`diagnoseMalformedEntries`, 249-281), `addDiagnostic` + `owner()` provenance attribution (40-71), capability-specific diagnostic codes (19-27), `{env:VAR}` substitution with `missing-env` diagnostics (107-132), cwd resolution relative to workspace (149-161).
- Capability section shape is decided per capability, not centrally: `mcp` is a named record; `commands`/`skills` are `{ paths: string[] }`.

### 1.6 Tests

- `apps/cli/src/shared/config/config-store.test.ts` (330 lines): ordered merge, JSONC-over-JSON + duplicate diagnostic (line 96), malformed/unsafe-key isolation (121), unreadable sources (155), scalar-replacement semantics (187), memoization (219), immutability (243), real-filesystem loading (263).
- `apps/cli/src/shared/config/filesystem-test-utils.ts` — `writeFixture` helper used by integration tests.

---

## 2. Current agent pipeline

There is **no `agents` module** in this fork (`ls apps/cli/src/modules` → auth, billing, commands, connections, conversations, custom-commands, file-mentions, mcp, model-pricing, prompt-settings, skills). The concept "agent" is today exactly the **mode** concept:

### 2.1 Definition (static, built-in only)

- `packages/ai/src/modes.ts:13-26` — `codingModes` is a hard-coded const array of two entries (`build`, `plan`), each with `description`, `displayName`, `tools` (a subset of the fixed `CodingToolName` union).
- `ModeType` (line 28) is derived from that array; `codingModeNameSchema = z.enum(codingModeNames)` (37-38) is a **closed union** used in three places:
  - `codingAgentCallOptionsSchema` (40-44) — per-call options passed to `ToolLoopAgent`
  - `packages/ai/src/metadata.ts:53` — message/session metadata validation
  - `apps/server/src/routes/sessions.ts:83` — hosted chat request body validation
- `parseMode` (52-55) falls back to `defaultMode` (line 50 = `build`) on unknown values — the current "unknown agent" behavior is silent fallback.

### 2.2 System prompts

- `packages/ai/src/instructions.ts` — `baseCodingAgentInstructions` (line 3), `modeInstructions` keyed by mode value (6-18), `getSystemInstructions(modeValue)` (20-21).
- Note: `createCodingAgent` in `packages/ai/src/server/agent.ts:82` passes `getSystemInstructions(defaultMode.value)` as the agent-level `instructions` (always *build*); the *mode* is applied per call through `prepareCodingAgentCall` (43-62), which gates `activeTools` from `getCodingMode(options.mode).tools` and disables MCP tools in `plan`.

### 2.3 Runtime flow (CLI, local route)

1. `prompt-settings/context/prompt-config-provider.tsx:59-85` — `PromptConfig` state holds `{ mode, model, variant }`; `setMode`/`cycleMode` are plain useState setters (`getNextCodingModeName` from `modes.ts:60-64`).
2. `/agents` command: `modules/commands/commands.ts:24-29` (kind `"mode"`), `commands/adapters/mode-adapter.ts` (opens dialog with `currentMode` + `setMode`), wired in `app/commands/use-app-command-executor.tsx:202-218` to `prompt-settings/ui/agents-dialog.tsx`, which renders `codingModes` directly (line 45).
3. `conversations/hooks/use-chat.ts` — `modeRef` (line 196), submit stores mode (337-339), mode stamped into message metadata (247, 317), tool-call handler gates by mode (`createChatToolCallHandler({ modeRef, ... })`, 281-286).
4. `conversations/hooks/local-chat-transport.ts:48-53` — builds `createCodingAgent({ model, ... })`; `mode: modeRef.current` passed in options (64-68).
5. `conversations/hooks/routing-chat-transport.ts:36` — `mcp.createSnapshot(modeRef.current)` (plan mode excludes MCP tools); hosted requests carry `{ mode, model, variant }` (66-78) via `conversations/api/chat-request.ts` (`mode: ModeType`, line 19).

### 2.4 Hosted route

- `apps/server/src/routes/sessions.ts` — `chatRequestSchema` validates `mode` with `codingModeNameSchema` (83); `deterministicSystemInstructions` (42-49) hard-codes build/plan prompts server-side; plan mode rejects MCP tools (315-317); billing funding math depends on `getDeterministicFundedContextTokenOverhead(mode)` (365) and message budgets (366-378); billing lifecycle receives `mode` (414-423).

### 2.5 Markdown/filesystem agents

**None for agents.** The filesystem "agent" artifacts are Skills: legacy *skill* dirs (`.agents/skills`, `.claude/skills`, `.opencode/skills` — `apps/cli/src/modules/skills/discovery.ts:11-15`) plus Wincode and configured roots composed by the CLI. There is no `.opencode/agent/` loading, no `AGENTS.md`-style loading, no plugin-defined agent loading in this fork. `grep -ri agent apps/cli/src` surfaces only: the `/agents` command, `AgentsDialogContent`, `createCodingAgent`/`CodingAgent*` AI-SDK types, and the Skill activation path. The repo root's `AGENTS.md -> CLAUDE.md` is a docs symlink, not runtime input.

### 2.6 Consumers summary

| Consumer | Where | What it needs |
|---|---|---|
| `/agents` dialog | `prompt-settings/ui/agents-dialog.tsx:45` | item list (currently `codingModes`) |
| Mode state | `prompt-config-provider.tsx:18-29` | `mode: ModeType` |
| Tool gating | `packages/ai/src/server/agent.ts:43-62`, `use-chat.ts:281-286` | mode → allowed `CodingToolName[]` |
| Instructions | `packages/ai/src/instructions.ts`, `server/agent.ts:82` | mode → system prompt |
| Metadata | `packages/ai/src/metadata.ts:53` | mode enum validation |
| Chat request body | `conversations/api/chat-request.ts:19`, `routing-chat-transport.ts:66-78` | mode string |
| Hosted server | `apps/server/src/routes/sessions.ts:83,315-317,365` | closed enum + built-in prompts |

---

## 3. Commands/skills precedent (commit `03b9bb5`)

### 3.1 What the commit did

`git show 03b9bb5 --stat` (21 files, +640/-135): added `skills.paths` / `commands.paths` config support, `resolve-config-relative-path.ts`, `project-roots.ts`, `config-provider.tsx`, config integration tests for both modules, and updated ADR-0001.

### 3.2 The flow, config file → runtime

1. `createConfigStore()` built in `root-layout.tsx:22`; snapshot obtained on demand via `ConfigRuntime.configStore.getSnapshot(workspace)` (e.g. `apps/cli/src/modules/skills/index.ts:13-23` `discoverSkills`, `modules/custom-commands/loader.ts:45-56` `getCustomCommands`).
2. `discovery.ts` per module: `configuredRoots(snapshot)` reads `snapshot.document.commands.paths` / `skills.paths` (`custom-commands/discovery.ts:31-53`, `apps/cli/src/modules/skills/discovery.ts:30-52`), type-checks the section defensively, then for each string entry calls `resolveConfigRelativePath(snapshot, ["skills","paths",String(index)], configuredPath)`.
3. `resolveConfigRelativePath` (`shared/config/resolve-config-relative-path.ts:9-22`) uses `snapshot.sourceFor(fieldPath)` to find the config file that supplied the entry and resolves relative paths from `dirname(origin.path)`; unknown provenance → entry skipped.
4. Conventional folders always participate: `getProjectRoots(workspace)` (`shared/paths/project-roots.ts:4-19`) walks from the workspace up to the nearest `.git` root; skills also scan legacy dirs and sibling `skills` dirs of each global config source.
5. `loader.ts` dedupes by name into a Map — later/higher-precedence candidates overwrite earlier ones — then sorts (custom-commands: built-in names checked first via `BUILTIN_NAMES` from `modules/commands/commands.ts`, collision → `console.warn` + skip, `custom-commands/loader.ts:9-42`; Skills: same-name overwrite, `packages/skills/src/filesystem.ts:151-166`). Invalid files are skipped best-effort.
6. Consumers: `conversations/ui/components/chat-text-area.tsx:234-242` builds `discoverCustomCommands`/`discoverAvailableSkills` closures from `useConfig()` and passes them to the input controller (299-309); `resolveCustomCommandPrompt`/`resolveSkillPrompt` (78-120) expand `/name args` into the prompt at submit; `skills/ui/skills-dialog.tsx:43-64` loads the list on open.

### 3.3 Established semantics worth preserving

- **Shape**: `{ <capability>: { paths: string[] } }` — arrays of directories, not inline definitions; arrays *replace* across config layers (shared merge contract, README.md:16-19).
- **Relative paths resolve from the config file that supplied the entry**, never from cwd (ADR-0001:25-28; `config.integration.test.ts:80-86` for commands — relative `configured-commands` in a workspace `.wincode/wincode.jsonc`).
- **Precedence**: built-ins > custom (with warning); project > global; conventional dirs always participate; configured paths are additive within scope; later configured path > earlier.
- **Scopes** are exactly `global | project` (`SkillCandidate.scope`, `CustomCommandCandidate.scope`).
- **Best-effort loading**: malformed/inaccessible files are skipped, never crash the app.
- **Fail-open frontmatter**: unknown frontmatter keys are ignored (`parse.test.ts:33` — `agent:`/`model:` frontmatter on command files is ignored).
- **Documented**: ADR-0001 (`docs/adr/0001-custom-commands.md`) records the considered options; module READMEs (`custom-commands/README.md`, `skills/README.md`) document discovery and precedence; `CONTEXT.md` gained domain terms in `8ccd853`.

---

## 4. Upstream OpenCode comparison (first-party sources only)

This fork is not a code fork of OpenCode — it is an independent codebase (remote `sonwjnn/wincode.git`) that borrows OpenCode conventions (`.opencode/` dirs, `opencode.json` — the old MCP loader read `opencode.json/jsonc` until `e3afe8e` removed it as a breaking change). The vendored `.opencode/package.json` pins `@opencode-ai/plugin@1.15.10`, so OpenCode **1.x** is the relevant upstream reference. Everything below is upstream behavior; it is *not* wincode behavior.

### 4.1 Upstream config agent schema (1.x)

- `packages/core/src/v1/config/agent.ts` (tag `v1.18.15`): agent fields `name`, `model`, `variant`, `temperature`, `top_p`, `prompt`, `description`, `mode` (`subagent|primary|all`), `hidden`, `color`, `steps`, `maxSteps` (deprecated), `options` (unknown-field passthrough), `permission`, `disable`, `tools` (deprecated → normalized into `permission`).
- Top-level config key in 1.x is **`agent`** (singular) — a record keyed by agent name (`packages/opencode/src/config/config.ts`, `result.agent` merges; `packages/opencode/src/agent/agent.ts:190-221` applies `Object.entries(cfg.agent)` with `disable` → delete).
- The current dev branch renames it to **`agents`** (plural): `packages/core/src/config.ts` (`agents: Schema.Record(Schema.String, ConfigAgent.Info)`; `default_agent` top-level) and `packages/core/src/config/agent.ts` (fields `model, variant, request, system, description, mode, hidden, color, steps, disabled, permissions`).
- Upstream config files: `opencode.json` / `opencode.jsonc` (global `~/.config/opencode/` + project walk + `.opencode/` dirs) — upstream never reads `wincode.json`.

### 4.2 Upstream markdown agents

- `packages/opencode/src/config/agent.ts` (`load`): globs `{agent,agents}/**/*.md` per directory, parses frontmatter, name from path, body → `prompt`. `loadMode`: `{mode,modes}/*.md`, forced `mode: "primary"`.
- Merge order in `packages/opencode/src/config/config.ts`: JSON config agents merged first; then markdown agents merged *over* them per directory (`mergeDeep`); `mode` map entries folded into agents. Built-ins (`build`, `plan`, `general`, `explore`, `compaction`, `title`, `summary`) are seeded in `packages/opencode/src/agent/agent.ts:103-190` and config entries override or extend them; `default_agent` picks the default; `disable` removes an agent.
- Upstream therefore has **three sources for the same concept** (built-in, JSON, markdown files), with named-record merging — quite different from wincode's `paths`-array philosophy for commands/skills.

### 4.3 What wincode deliberately deviates on

- Config filenames/namespaces: `wincode.json/jsonc` at 4 locations (config-store.ts:365-370) vs upstream's `opencode.json/jsonc` + `.opencode` dirs. ADR-0001:29-31 explicitly: wincode does **not** read `~/.config/opencode/commands/` or `~/.opencode/...` (except legacy *skills* dirs, `apps/cli/src/modules/skills/discovery.ts:11-15,76-92`).
- Commands: upstream 1.x `command` is a record of inline definitions (`packages/opencode/src/config/command.ts`, `config.ts` `result.command = mergeDeep(...)`); wincode uses `commands.paths` directories of markdown files.
- Skills: upstream `skills` is an array of path strings (`packages/core/src/config.ts` dev branch; v1 `skills` dirs via `{skill,skills}/**/SKILL.md` conventions); wincode uses `{ skills: { paths } }`.
- Built-in-vs-custom precedence is inverted (ADR-0001:19-22 — deliberate, wincode built-ins win).

---

## 5. Proposed seam

### 5.1 The clean slice

The store itself needs **no changes** — its README (`apps/cli/src/shared/config/README.md:21-23`) already states capability sections resolve themselves from the raw snapshot. The precedent-shaped minimal implementation:

1. **New module `apps/cli/src/modules/agents/`** mirroring `modules/skills/`:
   - `types.ts` — `AgentDefinition` (name, description, prompt/system, optional model/tools), `AgentCandidate` (`{ filePath?, scope }`), mirroring `skills/types.ts`.
   - `discovery.ts` — `discoverAgentCandidates({ homeRoot, snapshot, workspace })` reading the chosen config section off `snapshot.document`, using `resolveConfigRelativePath` + `getProjectRoots` exactly like `custom-commands/discovery.ts:31-53` / `apps/cli/src/modules/skills/discovery.ts:30-115`.
   - `loader.ts` — dedupe-by-name Map with defined precedence (built-in modes first with warning, project over global), best-effort skip on invalid entries (`packages/skills/src/filesystem.ts:151-166` pattern).
   - `index.ts` — `discoverAgents(input: ConfigRuntime)` composing snapshot + discovery + loading (`apps/cli/src/modules/skills/index.ts:13-23` pattern).
   - `config.integration.test.ts` + unit tests, modeled on `skills/config.integration.test.ts` (real tmpdirs, `writeFixture`, project-root walking with a fake `.git`).
2. **Widen the mode/agent union in `packages/ai`** — the true coupling point:
   - `packages/ai/src/modes.ts:13-38`: either relax `codingModeNameSchema` from `z.enum` to a validated string + runtime resolution, or add a separate `agent` axis alongside `mode` in `codingAgentCallOptionsSchema` (40-44). Every consumer of `ModeType` (sections 2.3-2.6) follows: `instructions.ts` mode-keyed prompts, `server/agent.ts:43-62` `prepareCodingAgentCall` tool gating (unknown agent → fail closed to no tools or explicit allowlist), `metadata.ts:53`, `apps/server` validation.
   - Tool safety: config agents may only reference tools in the fixed `CodingToolName` union; unknown tools must be rejected with a diagnostic, never silently granted.
3. **UI wiring**: `prompt-settings/ui/agents-dialog.tsx:45` switches from `codingModes` to discovered agents + built-ins; `prompt-config-provider.tsx` state becomes agent-id rather than closed enum (or gains a parallel field); `use-chat.ts:196,337` ref plumbing unchanged in shape.
4. **Server contract decision** (see Open decisions 9): hosted route `apps/server/src/routes/sessions.ts:83` either stays built-in-only (custom agents client-side only), or the request carries a validated agent payload.

### 5.2 Duplicated logic to reuse, not copy

- Relative-path resolution: `resolveConfigRelativePath` (`shared/config/resolve-config-relative-path.ts:9-22`) — single source of truth for "relative to the config file that supplied the entry".
- Project-root walking: `getProjectRoots` (`shared/paths/project-roots.ts:4-19`).
- Provenance-attributed diagnostics: the `owner()`/`addDiagnostic` pattern from `modules/mcp/config/resolve.ts:40-71` is the model for agent validation diagnostics (the shared store only emits generic codes, 19-26).
- Name validation: reuse the Skill `NAME_PATTERN` (`packages/skills/src/frontmatter.ts:6-11`, lowercase-hyphen 1-64) or the command filename rule; **do not** copy the mini-YAML frontmatter parser (`packages/skills/src/frontmatter.ts:22-61`) unless markdown agent files are adopted — it is line-based and documented as such.

### 5.3 Known coupling/backward-compat constraints

- `ModeType` is threaded through session persistence (`persistMessages({ mode })` — `use-chat.ts:257-266`), message metadata (`metadata.ts:53`), and the hosted API. Widening must keep old stored values (`build`/`plan`) valid.
- `parseMode` (`modes.ts:52-55`) currently silently falls back — if config agents are added, unknown mode fallback semantics must be made explicit (and ideally diagnosed).
- The shared merge contract (arrays replace) means a project `agents` section fully replaces the global one if the shape is a record; a `paths` array replaces per scope. Both are consistent with the store, but they are different semantics (record = replace whole map per layer; paths = additive within scope like commands/skills).
- No watcher: snapshots are memoized per process (`config-store.ts:422-434`); config changes require restart — same limitation documented for commands (ADR-0001:47-50).

---

## 6. Expected files and tests

**New**

- `apps/cli/src/modules/agents/types.ts` — agent/definition/candidate types
- `apps/cli/src/modules/agents/discovery.ts` — config-section reading + candidate discovery
- `apps/cli/src/modules/agents/loader.ts` — validation, dedupe, precedence
- `apps/cli/src/modules/agents/index.ts` — `discoverAgents(input: ConfigRuntime)`
- `apps/cli/src/modules/agents/README.md` — module contract (convention from `skills/README.md`)
- Tests: `agents/discovery.test.ts`, `agents/loader.test.ts`, `agents/config.integration.test.ts` (tmpdir + `writeFixture` + fake `.git` root walking, JSON and JSONC variants, project-over-global, built-in collision, invalid-entry isolation, relative-path resolution)

**Changed**

- `packages/ai/src/modes.ts` — schema/union widening (lines 13-55); `packages/ai/src/instructions.ts`; `packages/ai/src/metadata.ts:53`
- `packages/ai/src/server/agent.ts:43-62` — agent→tools/instructions resolution; `packages/ai/src/server/stream.ts`
- `apps/cli/src/modules/prompt-settings/context/prompt-config-provider.tsx`; `prompt-settings/ui/agents-dialog.tsx`
- `apps/cli/src/app/commands/use-app-command-executor.tsx:202-218`; `commands/adapters/mode-adapter.ts`
- `apps/cli/src/modules/conversations/hooks/use-chat.ts` (modeRef type), `local-chat-transport.ts:64-68`, `routing-chat-transport.ts:66-78`, `conversations/api/chat-request.ts:19`
- `apps/server/src/routes/sessions.ts:83,315-317,365` (only if the hosted contract changes)
- Docs: new ADR (extend `docs/adr/`), `CONTEXT.md` domain terms (precedent: `8ccd853`), `shared/config/README.md:21` wording if shape differs from other capabilities

**Test suites touched**

- `packages/ai/src/modes.test.ts`-adjacent call-options tests, `packages/ai/src/server/agent.test.ts`, `stream.test.ts`
- `apps/cli/src/modules/commands/commands.test.ts` / `adapters/adapters.test.ts` (`/agents` remains `kind: "mode"` unless agents get their own command kind)
- `config-store.test.ts` unchanged (store is domain-neutral)

---

## 7. Open decisions (required before implementation)

1. **Schema shape**: upstream-style named record `agents: { <name>: { prompt, description, model?, ... } }` (1.x key `agent`, dev-branch `agents`) **vs** wincode-precedent `agents: { paths: string[] }` (directories of markdown agent files) **vs both**. The record shape supports inline prompts + model/permission fields; the paths shape supports shared agent libraries. The fork's own ADR-0001 chose paths for commands/skills partly to mirror "battle-tested format" — the same argument pulls toward markdown files for agents.
2. **Key name**: singular `agent` (upstream 1.x) or plural `agents` (upstream dev). Wincode uses plural `commands`/`skills`, so `agents` is consistent — but `agent` maximizes copy-paste compatibility with OpenCode configs.
3. **Precedence/merge**: with the record shape, the shared store's recursive object merge means project `agents` per-key overrides global, arrays (if any) replace. With the paths shape, additivity-within-scope as commands/skills. Built-in `build`/`plan` are constants in `packages/ai/src/modes.ts` — may a config entry override them (upstream allows) and with what precedence?
4. **Filesystem collision**: should agents read legacy/OpenCode agent dirs (`.opencode/agent/*.md`, `~/.config/opencode/agent`, `.agents/`, `.claude/`)? Skills read legacy dirs; commands do not (ADR-0001:29-31). Which rule for agents?
5. **Relationship to modes**: are config agents a third source for the `/agents` list (modes = agents today), or a parallel axis (mode + agent)? This determines whether `codingAgentCallOptionsSchema` gains an `agent` field or replaces `mode`.
6. **Defaults**: add upstream-style `default_agent` config? Default stays `build`? Interaction with `defaultMode` (`modes.ts:50`).
7. **Disabling/removal**: `disabled`/`disable` field per agent (upstream semantics: delete on `disable`), and whether built-ins may be disabled or only overridden.
8. **Model/permission/options fields**: model strings must resolve through the catalog (`findSupportedChatModelSelection`, `packages/ai/src/models.ts`); temperature/top_p/options passthrough to AI SDK; permission field would be a new concept — wincode has no per-tool permission system (tool gating is per-mode lists in `modes.ts:17,22`). Scope of v1?
9. **Hosted route**: `apps/server` validates `mode` against the closed enum and computes deterministic billing overhead from built-in prompts (`sessions.ts:83,365`). Custom agents cannot be replicated server-side without reading client config (not present) or receiving agent payloads in the request (new security surface). v1 options: agents client-side-only (hosted route rejects/falls back), or contract extension.
10. **Relative-path resolution** if the paths shape is chosen: `resolveConfigRelativePath` with `["agents","paths",String(index)]` provenance — consistent with commands/skills; trivially adopted but must be decided explicitly.
11. **Diagnostics UX**: agent section validation errors — diagnostic list surfaced where? MCP surfaces through the registry/status UI; commands/skills are silent-skip. Agents affect chat behavior; silent fallback (`parseMode`) may be unacceptable.

---

## 8. Risks

- **Closed-enum coupling**: `codingModeNameSchema` is baked into call options (`modes.ts:40-44`), session metadata (`metadata.ts:53`), and the hosted API (`sessions.ts:83`). Widening it touches every transport and the server contract; a half-widened schema (string enum mismatch) would silently fall back to `build` via `parseMode` (`modes.ts:52-55`).
- **System-prompt trust**: agent prompts are user-authored text inserted into the system prompt; with the full tool set (`prepareCodingAgentCall` grants all `codingMode.tools`), a config agent is a full-trust prompt-injection vector. Tool allowlisting must fail closed, and unknown tool names must be diagnosed, not ignored.
- **Hosted/billing determinism**: server-side token budgeting depends on built-in mode prompts (`sessions.ts:365-378`); custom agent prompts break deterministic funding and could be an abuse vector if ever passed through the hosted route.
- **Schema drift vs upstream**: if the record shape is chosen, fields that wincode won't support in v1 (`permission`, `request`, `options`, `color`, `temperature`) must fail open or produce diagnostics, mirroring the command-frontmatter fail-open decision (ADR-0001:14-16, `custom-commands/parse.test.ts:33`).
- **Provenance pitfalls**: relative paths resolved against the wrong source (a later layer replacing the array) would silently load agents from an unintended directory; the `sourceFor` per-index provenance (`config-store.ts:394-401`) must be exercised for each merged layer, as commands/skills already do.
- **No watcher**: agents are fixed at process start (`config-store.ts:422-434` memoization); mid-session config edits require restart — acceptable for v1 (precedent ADR-0001:47-50) but must be documented.
- **Name collisions with future built-ins**: `/agents` built-in command (`commands.ts:24-29`) is UI, but agent *names* colliding with reserved names (`build`, `plan`) needs explicit semantics (override, warn, or block) before the loader exists.

---

## 9. Sources

### Repository (first-party, this fork)

- `apps/cli/src/shared/config/config-store.ts` — store, locations (365-370), selection (270-295), parse/safety (297-336), merge+provenance (161-180, 136-159), `sourceFor` (394-401), memoization (422-434)
- `apps/cli/src/shared/config/README.md:16-23` — merge contract; agents named as a future capability on the snapshot
- `apps/cli/src/shared/config/config-provider.tsx`, `resolve-config-relative-path.ts:9-22`, `apps/cli/src/shared/paths/project-roots.ts:4-19`
- `apps/cli/src/modules/custom-commands/discovery.ts:31-53`, `loader.ts:9-43`, `config.integration.test.ts`; `apps/cli/src/modules/skills/discovery.ts:11-15,30-121`, `packages/skills/src/filesystem.ts:73-166`, `packages/skills/src/index.ts`, `packages/skills/src/frontmatter.ts:4-73`, `apps/cli/src/modules/skills/config.integration.test.ts`, `skills-dialog.tsx:43-64`
- `apps/cli/src/modules/mcp/config/schema.ts`, `config/resolve.ts:19-27,40-71,249-330`; `apps/cli/src/modules/mcp/config.ts:31-50`
- `apps/cli/src/modules/prompt-settings/context/prompt-config-provider.tsx:59-85`, `prompt-settings/ui/agents-dialog.tsx:45`
- `apps/cli/src/modules/commands/commands.ts:17-33`, `commands/adapters/mode-adapter.ts`, `app/commands/use-app-command-executor.tsx:202-218`
- `apps/cli/src/modules/conversations/hooks/use-chat.ts:196,247,257-266,281-286,337-339`, `local-chat-transport.ts:48-53,64-68`, `routing-chat-transport.ts:36,66-78`, `conversations/api/chat-request.ts:19`, `conversations/ui/components/chat-text-area.tsx:234-309`
- `packages/ai/src/modes.ts:13-69`, `instructions.ts:3-21`, `metadata.ts:53`, `server/agent.ts:43-62,73-100`, `server/stream.ts`
- `apps/server/src/routes/sessions.ts:42-49,83,313-317,365-378,414-447`
- Commits: `e3afe8e` (shared store, MCP migration, `opencode.json` dropped), `03b9bb5` (commands/skills from config), `8ccd853` (custom commands, CONTEXT.md terms), `f77efd3` (config store real-file tests), `6b55364` (eager command fetch)
- `docs/adr/0001-custom-commands.md`; `CONTEXT.md` (Built-in Command / Custom Command terms); `apps/cli/src/modules/skills/README.md`, `custom-commands/README.md`

### Upstream OpenCode (first-party, clearly distinct from this fork)

- https://github.com/sst/opencode/blob/v1.18.15/packages/core/src/v1/config/agent.ts — 1.x agent schema (`agent` key, `disable`, `permission`, etc.)
- https://github.com/sst/opencode/blob/v1.18.15/packages/opencode/src/config/config.ts — config loading, `result.agent` merge, markdown agent merge order, `mode`→agent folding
- https://github.com/sst/opencode/blob/v1.18.15/packages/opencode/src/config/agent.ts — `{agent,agents}/**/*.md` and `{mode,modes}/*.md` markdown loading
- https://github.com/sst/opencode/blob/v1.18.15/packages/opencode/src/agent/agent.ts — built-in agents, config override/disable semantics, `default_agent`
- https://github.com/sst/opencode/blob/dev/packages/core/src/config.ts and .../dev/packages/core/src/config/agent.ts — dev-branch `agents` (plural) schema, `default_agent`
- Fork pins `@opencode-ai/plugin@1.15.10` (`.opencode/package.json`), i.e. the 1.x era is the relevant upstream baseline.
