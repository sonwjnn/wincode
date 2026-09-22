# Development Rules

## Default Context

This repo contains multiple packages, but `packages/tui/` is the primary focus. Unless otherwise specified, assume work refers to this package.
---
### Package Structure


| Package                 | Description                                                                             |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `packages/agent-runtime-ai-sdk`         | Multi-provider LLM client with streaming support, Model catalog                                      |
| `packages/ai`         | Model catalog                                      |
| `packages/agent`        | Agent runtime with tool calling and state management                                    |
| `packages/tui` | Main CLI application (primary focus)                                                    |
| `packages/runtime-utils`| Shared utilities                                       |

---
## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.

---

## Commands

- **Format code**: `bun run fix` (Most formatting and common issues are automatically fixed. Run it before committing to ensure compliance)
- **Check for issues**: `bun run check`
- **Type check all workspaces**: `bun run check-types`
- **Run the Default test portfolio**: `bun run test`
- **Run TUI E2E tests**: `bun run test:e2e`
- **Start the CLI in watch mode**: `bun run dev:cli`  

---

## Testing Guidance

Tests are contract-first. Every test must defend one externally observable behavior,
state transition, error mapping, precedence rule, or regression-prone boundary, and
its name or nearby rationale must state the consumer-visible failure mode. If you cannot name the contract, do not add the test.

---

## Persistence rule

This is a solo-dev project. The local SQLite schema is synchronized directly
from the current Drizzle schema; Wincode does not maintain migration history.
Use `bun run --cwd packages/tui db:push` after schema changes. If a schema change
cannot be reconciled safely, delete the local database and attachment data
before restarting; no compatibility migration is provided.

---

## Agent skills

### Issue tracker

Issues and PRDs for this repo live as GitHub issues, created and read via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles mapped to label strings: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Multi-context layout: a root `CONTEXT-MAP.md` points to per-context `CONTEXT.md` + `docs/adr/` files, with system-wide decisions at the root `docs/adr/`. See `docs/agents/domain.md`.