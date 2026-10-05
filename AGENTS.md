# Development Rules

## Default Context

## This repo contains multiple packages, but `packages/coding-agent/` is the primary focus. Unless otherwise specified, assume work refers to this package.

### Package Structure


| Package                 | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `packages/agent-core`   | Agent Turns, records, events, runtime and generic tool contracts |
| `packages/ai`           | Model catalog, Multi-provider LLM client with streaming support  |
| `packages/coding-agent` | Main CLI application, including Skills and concrete coding tools |
| `packages/config`       | Shared configuration contracts and loaders                       |
| `packages/utils`        | Shared utilities                                                 |


---

## GitHub

### Pull requests

When authorized to create or edit a PR, follow the checklist below.

- MUST `.github/pull_request_template.md` first. Preserve the template sections and checklist, including when shortening an existing description.
- MUST read back the published PR description after creating or editing it. Check only verified checklist items; explain skipped or inapplicable checks in `Testing`.

---

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **NEVER use preserve backward compatibility** unless the user asks for it.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privac**: #private fields for private members, bare for public ones. No private/protected/public modifiers on fields or methods — except constructor parameter properties, where TS requires them (e.g. constructor(private readonly session: SessionType))
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **NEVER modify `packages/ai/src/generated/model-metadata.generated.ts`** directly; update `packages/ai/scripts/sync-model-metadata.ts` instead, then regenerate. Including the resulting `model-metadata.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes.

---

## Commands

- NEVER commit unless asked.
- NEVER use `tsc/npx tsc` — always `bun check`
- Most formatting and common issues are automatically fixed. Run it before committing to ensure compliance - `bun fix`
- Type check all workspaces — `bun check-types`
- Run the Default test portfolio (CI Default lane) — `bun run test`
- Run the E2E test portfolio (CI E2E lane) — `bun run test:e2e`
- Start the CLI in watch mode — `bun dev:cli`

---

## Testing Guidance

Tests **MUST BE** contract-first. Every test **MUST** defend one externally observable behavior,
state transition, error mapping, precedence rule, or regression-prone boundary, and
its name or nearby rationale must state the consumer-visible failure mode. If you cannot name the contract, **DO NOT** add the test.

---

## Central Utilities

Before writing a helper, check whether one already exists — `packages/coding-agent/shared/utils/`, `@wincode/utils`, and the domain modules next to your callsite. This applies to **everything**.

- Search first: `grep` for the operation before implementing it. Two implementations of the same thing is a bug even when both work.
- Missing capability? Extend the central helper (new option, new sub-function on the namespace) and call it — don't fork its logic locally.

---

## Bun Over Node

Prefer Bun-native APIs whenever they preserve the required observable behavior; use `node:*` only when no Bun-native API preserves that contract. Avoid spawning a process when an in-process API can perform the same operation; keep external processes when running the external program is itself required.

### Quick reference


| Operation       | Use                                                                                                           | Not                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| File read/write | `readUtf8File()` / `decodeUtf8()` (`@wincode/utils`); `Bun.file().bytes()`, `Bun.write()`             | `readFileSync`, `writeFileSync`                                       |
| Spawn process   | `$cmd`, `Bun.spawn()`                                                                                         | `child_process`                                                       |
| Sleep           | `Bun.sleep(ms)`                                                                                               | `setTimeout` promise                                                  |
| Binary lookup   | `$which("git")` from `@oh-my-pi/pi-utils`                                                                     | `spawnSync(["which", "git"])`                                         |
| HTTP server     | `Bun.serve()`                                                                                                 | `http.createServer()`                                                 |
| SQLite          | `bun:sqlite`                                                                                                  | `better-sqlite3`                                                      |
| Hashing         | `Bun.CryptoHasher` / Web Crypto (cryptographic); `Bun.hash` (non-cryptographic); `Bun.password.*` (passwords) | `node:crypto` when an equivalent Bun API exists                       |
| UUID generation | `crypto.randomUUID()`                                                                                         | `node:crypto.randomUUID()` when Bun exposes the same contract         |
| Base64          | `Uint8Array.fromBase64()` / `.toBase64()` for validated data                                                  | `Buffer.from(..., "base64")` when permissive decoding is required     |
| Path resolution | `import.meta.dir`, `import.meta.path` for current module                                                      | `fileURLToPath(import.meta.url)`                                      |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`                                                                          | `json5` package                                                       |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`                                                                         | `text.split("\n").map(JSON.parse)`                                    |
| Deep equality   | `Bun.deepEquals(a, b, true)` for strict JSON-shaped values                                                    | `node:util.isDeepStrictEqual` when Bun preserves the needed semantics |
| String width    | `Bun.stringWidth()`                                                                                           | `get-east-asian-width`, custom                                        |
| Text wrapping   | `Bun.wrapAnsi()` when word, whitespace, and Unicode boundaries match                                          | custom layout semantics                                               |


`Bun.file(path).text()` strips a leading UTF-8 BOM, unlike Node UTF-8 reads. Use `readUtf8File()` when preserving that behavior; `Bun.write()` creates missing parent directories and does not provide Node's exclusive, permission, or append semantics.

`import.meta.path` identifies only the current module; use `fileURLToPath()` for a resolved asset URL when an OS path is required.

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

---

## Logging and CLI Output

Code that may run while the TUI, RPC or background runtimes are active **MUST NOT** use `console.log`/`error`/`warn`; it corrupts rendering or protocols. Use the centralized logger:

```
import { logger } from "@wincode/utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.wincode/logs/wincode.YYYY-MM-DD.log`  or with WINCODE_DEBUG go to `./.wincode/logs/wincode.YYYY-MM-DD.log` with automatic rotation. Standalone CLI commands that exit without entering the TUI MAY use `console.*` or process streams for intentional user-facing output. Keep structured stdout clean. This exception is semantic, not filename-based; shared code must use `logger` or an explicit output sink.

---

## Persistence rule

This is a solo-dev project. The local SQLite schema is synchronized directly
from the current Drizzle schema; Wincode does not maintain migration history.
Use `bun run --cwd packages/coding-agent db:push` after schema changes. If a schema change
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