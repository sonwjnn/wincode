# Development Rules

## Default Context

## This repo contains multiple packages, but `packages/tui/` is the primary focus. Unless otherwise specified, assume work refers to this package.

### Package Structure

| Package                         | Description                                                     |
| ------------------------------- | --------------------------------------------------------------- |
| `packages/agent-runtime-ai-sdk` | Multi-provider LLM client with streaming support, Model catalog |
| `packages/ai`                   | Model catalog                                                   |
| `packages/tui`                  | Main CLI application (primary focus)                            |
| `packages/runtime-utils`        | Shared utilities                                                |

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

- **Format code**: `bun run fix` (Most formatting and common issues are automatically fixed. Run it before committing to ensure compliance)
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

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

| Operation       | Use                                       | Not                                |
| --------------- | ----------------------------------------- | ---------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync`    |
| Spawn process   | `$cmd`, `Bun.spawn()`                     | `child_process`                    |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise               |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils` | `spawnSync(["which", "git"])`      |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`              |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                   |
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                      |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance              |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                    |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom     |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers         |

### Process execution

Prefer Bun Shell (`$cmd`) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then [`fs.promises.xxx`](http://fs.promises.xxx) for async.

### File I/O

Prefer Bun:

```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**

- `existsSync`/`readFileSync`/`writeFileSync` in async code → Bun.file() APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; Bun.write handles it.

- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

---

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

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
