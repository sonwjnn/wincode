# Coding tools and Skills are coding-agent modules

Status: accepted

`@wincode/coding-tools` and `@wincode/skills` declare a reusable seam that has no
consumer: every call site lives inside `@wincode/coding-agent`, and no build,
publish, or external integration consumes either package. They become
`modules/tools/` and `modules/skills/` of the Coding-Agent Application, and the
one contract `@wincode/agent-core` needs from Skills moves into core. This
supersedes the package list of ADR-0010; its acyclic concern-package rule and the
remaining package roles stay in force.

## Decision

- Both packages stop being workspace packages. Their sources become
  `packages/coding-agent/modules/tools/` and `packages/coding-agent/modules/skills/`;
  the workspace entry, lockfile records, dependency declarations, per-package
  `tsconfig.json`, package scripts, and the stale `packages/skills/dist` build
  info are deleted with no compatibility alias, re-export, or forwarding package.
- `modules/skills/` is one module: the absorbed catalog and activation, context,
  frontmatter parsing, body hashing, invocation parsing, and Skill types, plus
  the application's existing root-descriptor discovery. `modules/tools/` is the
  absorbed coding tools with the package's inner `tools/` level collapsed, so
  `edit/`, `glob/`, `grep/`, `read/`, `recover/`, `shell/`, `write/`,
  `versioned/`, and `workspace.ts` sit directly under the module.
- Each module exposes exactly one barrel — `@/modules/skills` and
  `@/modules/tools`. The `./filesystem` and `./workspace` subpath exports are not
  preserved: they existed to keep a portable contract free of Node/Bun
  dependencies, which no longer describes anything inside one application
  process. Cross-module imports use the `@/modules/...` alias; imports within an
  absorbed module stay relative.
- `SkillActivationSource` and `SKILL_ACTIVATION_SOURCES` move to
  `@wincode/agent-core` as their own leaf module, re-exported from the core
  barrel. Core drops its `@wincode/skills` dependency, and the absorbed Skill
  implementation imports the vocabulary from core, so the graph stays acyclic:
  `coding-agent → agent-core`.
- Tests move under `packages/coding-agent/test/`: `test/skills/` for the three
  absorbed Skill tests and `test/tools/` for the absorbed coding-tool test, which
  is renamed so it no longer shares a basename with the session-level
  `test/sessions/versioned-editing.test.ts`.
- Skill activation semantics, Tool Permission gating, workspace policy, edit
  verification, and every public contract of the application are unchanged. The
  move is mechanical: file locations, import specifiers, and package metadata
  only.

## Considered options

- **Keep both packages, nested under `packages/coding-agent/`** — rejected. It
  preserves nine workspace packages and the cross-package tax for a boundary
  nothing outside the application consumes.
- **Absorb `coding-tools` only** — rejected. `skills` has the same single
  consumer; the only real argument for keeping it was core's need for
  `SkillActivationSource`, and that is resolved by moving the type rather than
  keeping a package for it.
- **Absorb `skills` without relocating the type** — rejected. `agent-core` would
  import from the composition root, inverting the direction ADR-0010 established
  and creating a cycle.
- **Preserve `./filesystem` and `./workspace` subpaths** — rejected. Their
  justification was portability of a contract consumed outside the application.
- **Restructure the absorbed files while moving them** — rejected. Merging or
  renaming files beyond the `tools/` collapse would bury a mechanical change
  inside an unreviewable diff.

## Consequences

- `@wincode/coding-agent` now owns the Skill catalog, parsing, and the concrete
  coding tools. Reuse of either requires extracting a package again; that is the
  accepted cost of removing a boundary that had no second consumer.
- ADR-0004 (Skill contracts, parsing, catalog, and activation semantics),
  ADR-0024 (edit and mutation ownership), ADR-0019, and ADR-0025 keep their
  decisions; only the package names they mention are historical.
- The package graph in ADR-0010 is reduced to `@wincode/ai` and
  `@wincode/agent-core` as reusable packages, `@wincode/agent-runtime-ai-sdk` as
  the private adapter, and `@wincode/coding-agent` as the composition root.
