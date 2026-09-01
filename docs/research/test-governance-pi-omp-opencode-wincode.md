# Quản trị test và hạ tầng integration/E2E ở Pi, OMP, OpenCode — đối chiếu với Wincode

| | |
|---|---|
| Ngày nghiên cứu | 2026-08-31 |
| Pi | Repository [`earendil-works/pi`](https://github.com/earendil-works/pi), revision [`853a80d`](https://github.com/earendil-works/pi/tree/853a80d26c90a14c1886f0ebb8ffaae133ca2185) (main head khi clone). Lưu ý định danh: `badlogic/pi-mono` hiện **301 redirect sang `earendil-works/pi`** (xác minh 2026-08-31), đúng với quy ước của loạt note trước trong `docs/research/`. |
| Oh My Pi (OMP) | Repository [`can1357/oh-my-pi`](https://github.com/can1357/oh-my-pi), revision [`65f79e7`](https://github.com/can1357/oh-my-pi/tree/65f79e76fcc89b96632fe86a598f314bd7cfc725) (main head khi clone) |
| OpenCode | Repository [`anomalyco/opencode`](https://github.com/anomalyco/opencode), revision [`9f69463`](https://github.com/anomalyco/opencode/tree/9f69463f1d556af2b5b51d2efa1c04f5f544f911) (main head khi clone) |
| Wincode | Repository [`sonwjnn/wincode`](https://github.com/sonwjnn/wincode), HEAD cục bộ `54635ed` (feat(conversations): persist compaction config). Mọi dẫn chiếu Wincode là đường dẫn + dòng **trong repo cục bộ** (repository evidence), không phải permalink GitHub vì HEAD chưa chắc đã được push. |
| Phạm vi | Chỉ quản trị test: taxonomy, runner/tools, fixture/harness, CI enforcement, chính sách chống test rác, khi nào **không** thêm test. Không xét formatter/linter/build, không đánh giá chất lượng từng test cụ thể. |

## Kết luận điều hành (đã xác minh từ source)

- **Cả ba upstream đều có một chuẩn chung rất rõ**: test phải bảo vệ một **contract bên ngoài quan sát được**, chạy **deterministic** (offline mặc định, môi trường hermetic, mock model thay vì API thật), và bị ép bởi **CI** — còn pre-commit hook thì **không chạy test** (chỉ format/lint/typecheck). Wincode hiện thiếu 2/3 trụ đó: có kỷ luật nội dung tốt ở từng file (test contract-level, env-gated), nhưng **không có CI**, và script `test:integration` trỏ tới một file **không tồn tại**.
- **Phân loại integration rõ 3 nấc** (đều thấy ở Wincode nhưng chưa được đặt tên/khai báo): (1) in-process composition trên seam (VD `api.integration.test.ts` ghép Hono router với subrouter stub), (2) real-IO (subprocess/filesystem/SQLite thật — `runner.integration.test.ts`, các test `drizzle-*.integration.test.ts`), (3) external-service, env-gated (Postgres thật qua `describe.skipIf(!DATABASE_URL)`). Upstream gọi nấc 3 là "e2e/integration có điều kiện" và **giữ nó ngoài đường chạy mặc định**.
- **E2E thật sự** (full-stack, browser/terminal) chỉ OpenCode có ở quy mô đáng kể (Playwright trên `packages/app/e2e`); OMP có e2e TUI qua **virtual terminal** (không cần terminal thật); Pi không có E2E browser — dùng **model-backed evals** (vitest-evals) tách hẳn khỏi CI, chạy theo yêu cầu có API key.
- **Chống test rác** được mã hóa thành văn bản bắt buộc: OMP ghi rõ nhất trong `AGENTS.md` (contract-first, cấm static echo/source-grep/tautology, "không thêm test cho thay đổi nhỏ rủi ro thấp"); Pi buộc test regression **gắn số issue**; OpenCode có `test/AGENTS.md` + `e2e/AGENTS.md` với luật chống flake (cấm sleep, chờ readiness signal).
- **Kiến nghị cốt lõi cho Wincode**: (a) sửa/làm đúng script `test:integration`; (b) thêm CI lane tối thiểu (`bun test` + `test:postgres`); (c) chép khuôn khổ contract-first + anti-pattern từ OMP `AGENTS.md` vào `AGENTS.md` của Wincode; (d) giữ Bun test runner, không đưa vitest/Playwright vào trừ khi có nhu cầu e2e web thật.

## Hiện trạng Wincode (baseline, HEAD `54635ed`)

**Số liệu (đếm bằng `git ls-files`):**
- 145 file `*.test.ts(x)` được track: **125 unit** + **20 file có "integration"** (19 file đặt tên `*.integration.test.ts` + 1 file `repository.postgres.test.ts` nằm trong `apps/server/tests/integration/`).
- Không có file `*.e2e.*`, không có `*.spec.*`; **không có** config Playwright/Vitest nào trong repo; **không có** `.github/workflows/*` (glob `.github/**` trả "Path not found") — tức **chưa có CI**.
- Test **colocated** ngay cạnh source (`apps/cli/src/modules/...`, `apps/server/src/routes/...`, `packages/ai/src/tools/...`).

**Scripts root (`package.json` L37–40):**
```jsonc
"test":            "bun test apps/cli/src apps/server/src apps/web/src packages/ai/src packages/billing/src",
"test:unit":       "bun test apps/cli/src apps/server/src apps/web/src packages/ai/src packages/billing/src",
"test:integration": "bun test integration.test.ts",
"test:postgres":   "bun test apps/server/tests/integration/billing/repository.postgres.test.ts"
```
- `test` và `test:unit` **giống hệt nhau** — không có lane riêng nào được đặt tên.
- `test:integration` trỏ tới `integration.test.ts` ở root — file **không tồn tại** (xác minh: `Path 'integration.test.ts' not found`). Script chạy sẽ lỗi.
- Mỗi workspace có script `test` riêng: `apps/cli` `bun test src`, `apps/server` `bun test src` + `test:postgres` riêng, `apps/web` `bun test src`, `packages/ai` và `packages/billing` `bun test src` (đọc từ từng `package.json`).
- `bunfig.toml`: `[test] pathIgnorePatterns = ["**/dist/**"]`.
- `lefthook.yml`: pre-commit chỉ có `biome check --write` + `biome check` — **không chạy test**.
- `AGENTS.md` (mục Testing): ngắn gọn — assertion trong `it()`/`test()`, không `done` callback, **không commit `.only`/`.skip`**, giữ suite phẳng.

**Ba nấc integration hiện diện trong repo (bằng chứng cụ thể):**

1. **In-process composition** — `apps/server/src/routes/api.integration.test.ts` (31 dòng): dựng `createApiRoutes` với các subrouter **stub** (`billingRoutes`, `credentialsRoutes: new Hono()`, `sessionsRoutes: new Hono()`), gọi `apiRoutes.request(...)` **trong tiến trình**, không network, không DB. (L1–31)
2. **Real-IO (subprocess/filesystem)** — `packages/ai/src/tools/shell/runner.integration.test.ts` (237 dòng): chạy `/bin/bash`/`powershell.exe` thật, temp dir qua `mkdtempSync` + `realpathSync` (chú thích symlink `/var → /private/var` trên macOS, L17–24), kill process tree lúc timeout, kiểm tra truncation banner 30 KiB, resource profile, background child giữ pipe (L83–237).
3. **External service, env-gated** — `apps/server/tests/integration/billing/repository.postgres.test.ts` (838 dòng): Postgres thật qua `Pool` của `@neondatabase/serverless`, `DATABASE_URL` từ env với fallback `postgres://localhost/wincode-test`, cách ly dữ liệu bằng tiền tố `billing_pg_${crypto.randomUUID()}` (L1–63), và **`describe.skipIf(!hasDatabaseUrl)`** (L93) — mẫu env-gate đúng chuẩn. Cùng nhóm: các test `drizzle-*.integration.test.ts` trong `apps/cli/src/modules/conversations/storage/` (SQLite thật qua Drizzle).

## Pi (`earendil-works/pi`, `853a80d`)

### Taxonomy & runner
- **474 file test** phân theo package: `packages/coding-agent` 246, `packages/ai` 137, `packages/tui` 33, `packages/agent` 23, `session-backends` 11, `server` 7, `client` 6, `evals` 4, `protocol` 3, `scripts` 2, `telemetry` 2.
- Runner: **Vitest theo package** (`vitest.config.ts` trong từng package, dùng chung `vitest.base.ts` với alias workspace) + **`node --test`** cho script repo ([package.json L34](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/package.json#L34): `"test:scripts": "node --test scripts/*.test.mjs"`). Root `test` = `npm run test:scripts && npm run test --workspaces --if-present` ([L33](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/package.json#L33)).
- **Vị trí test: thư mục `test/` riêng, không colocate** — ví dụ `packages/coding-agent/test/` gồm `suite/` (82 file), `suite/regressions/` (**71 file, đặt tên theo số issue**: `1717-2113-agent-session-event-settlement.test.ts`, `2753-reload-stale-resource-settings.test.ts`, `3303-find-nested-gitignore.test.ts`…), `fixtures/`, `session-manager/`, `client/`, `server/`.

### Integration harness (điểm đáng học nhất)
- `test/suite/README.md` [L3–9](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/test/suite/README.md#L3-L9): suite mới quanh `AgentSession`/`AgentSessionRuntime` bắt buộc dùng `test/suite/harness.ts` + **faux provider** (`packages/ai/src/providers/faux.ts`); "Do not use real provider APIs, real API keys, network calls, or paid tokens"; "Keep these tests CI-safe and deterministic".
- **Offline mặc định**: `packages/coding-agent/vitest.config.ts` [L11–13](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/vitest.config.ts#L11-L13) — `testTimeout: 30000`, `env: { PI_OFFLINE: "1" }`, "opt in with allowNetwork() from test/test-network-env.ts".
- **E2E env-gated**: 6 file `.e2e.test.ts` (`packages/agent/test/e2e.test.ts`, `packages/ai/test/anthropic-long-cache-retention-e2e.test.ts`, `openai-codex-cache-affinity-e2e.test.ts`…); gate bằng `it.skipIf(!testCase.apiKey)` ([anthropic-long-cache-retention-e2e.test.ts L122](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/test/anthropic-long-cache-retention-e2e.test.ts#L122)). `AGENTS.md` [L33](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/AGENTS.md#L33): "Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present" — e2e chỉ bật khi có credential, mặc định CI-safe.
- **Hermetic runner**: `test.sh` (L1–16, L79) — dựng `$HOME`/`TMPDIR`/cache cô lập trong `mktemp -d`, chạy `env -i` với chỉ PATH/PWD/HOME, `GIT_CONFIG_NOSYSTEM=1`, `PI_NO_LOCAL_LLM=1`, chặn credentials, dọn dẹp có kiểm tra ownership (`.pi-test-owned`).

### E2E / evals
- Không có browser E2E. Thay vào đó là **evals model-backed** ở `packages/evals`: [README L3–6](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/evals/README.md#L3-L6) — "behavioral, model-backed checks for Pi workflows. They adapt a real `AgentSession` to `vitest-evals`, run it in isolated temporary project and agent directories". Chạy riêng: `npm run eval -- --provider openai --model …` (root [L29](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/package.json#L29)); **không nằm trong `npm test`/CI** vì cần API key. Kèm cơ chế so sánh harness (`evalHarnessTable`, judge score, lift pass-rate) và nguyên tắc "dùng hard assertion chỉ cho suite invariants".

### CI enforcement & review gate
- [`ci.yml`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/.github/workflows/ci.yml): một job `build-check-test` (L14) — `npm ci --ignore-scripts` → `npm run build` → `npm run check` → `npm test` (L33–42) trên mọi push main và PR vào main.
- **PR gate nhân sự**: `pr-gate.yml` tự đóng PR của contributor chưa được duyệt (danh sách `.github/APPROVED_CONTRIBUTORS`, lệnh `lgtm` của maintainer); `issue-gate.yml` tương tự cho issue. Đây là review gate chống spam, không phải test gate.
- **Pre-commit không chạy test**: `.husky/pre-commit` chạy `npm run check` (biome + typecheck + kiểm tra lockfile) và `check:browser-smoke` **có điều kiện** khi chạm `packages/ai`/`packages/web-ui` — nhưng `check:browser-smoke` là **esbuild bundle check** (build entry cho browser, kiểm tra tree-shaking provider), không phải chạy trình duyệt thật.
- `CONTRIBUTING.md` [L60–64](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/CONTRIBUTING.md#L60-L64): "Before submitting a PR: `npm run check` and `./test.sh`. Both must pass." — chuẩn giao nộp là **check + toàn bộ test (hermetic)**.
- `AGENTS.md` [L38](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/AGENTS.md#L38): "When regressions tests for fixing a github issue, add a comment with the github issue number next to the test." — **regression phải gắn số issue**, thể hiện cả ở tên file trong `test/suite/regressions/`.

## Oh My Pi (`can1357/oh-my-pi`, `65f79e7`)

### Taxonomy & runner
- **2.342 file `*.test.ts`**: `packages/coding-agent` 1.402, `packages/ai` 399, `catalog` 101, `omptype` 86, `utils` 82, `tui` 81, `mnemopi` 75, `agent` 37, `stats` 20, `natives` 14, `hashline` 12, `metaharness` 8, `collab-web` 5, `robomp` 2, `typescript-edit-benchmark` 2. Cộng **402 file Rust** (test trong crate, `crates/pi-natives/src/utok/tests/*.rs`…) và **pytest** cho Python (`test:py` = `python3 -m pytest -x python/omp-rpc/tests && …`, [package.json L143](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/package.json#L143)).
- Runner: **`bun test`** điều phối bởi script riêng `scripts/ci-test-ts.ts` (root `test` = `bun scripts/ci-test-ts.ts local`, [L97](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/package.json#L97)); Rust qua `cargo nextest` + `cargo test --doc` ([L100](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/package.json#L100), `AGENTS.md` L253).

### Integration setup: phân vùng test theo đặc tính runtime (điểm độc đáo)
`ci-test-ts.ts` **tự phân loại 1.402 test của coding-agent thành 4 bucket** bằng path pattern + content markers:
- `singleton` (global-state, serial `parallel=1`), `ui` (UI/TUI, `chunkSize: 5` — lý do: native ghostty-vt cells gây crash GC của bun 1.3.14 khi ~10 file chung heap), `runtime` (session, `chunkSize: 10`), `native` (native/tooling/browser/unit, `chunkSize: 10`) — [L139–143](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/scripts/ci-test-ts.ts#L139-L143), markers L151–215. Mỗi chunk là một tiến trình `bun test` riêng (chống OOM, dọn child process).
- **Hermetic env**: scrub `AWS_*`, `GOOGLE_CLOUD_*`, `*_API_KEY`, `*_OAUTH_TOKEN`, `BEARER_TOKEN`, `GITHUB_TOKEN`… khỏi child env để credential không làm test non-deterministic ([L381–399](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/scripts/ci-test-ts.ts#L381-L399)); `GITHUB_ACTIONS` bị xóa; GC knobs `BUN_JSC_useConcurrentGC=0`, `BUN_JSC_numberOfGCMarkers=1` (L447+); watchdog 600s/chunk; **retry chunk khi bun crash** (`MAX_CHUNK_ATTEMPTS = 3`, L432) và phân biệt OOM (137) với crash trong báo lỗi; per-test timeout 30s.
- **Flake policy**: `.config/nextest.toml` [L22–23](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/.config/nextest.toml#L22-L23): `retries = 0` — "No retries: a flaky test is a bug we want to see, not paper over." Kèm `fail-fast = false`, `slow-timeout = { period = "60s", terminate-after = 4 }`. Rust test local tự skip khi không có file Rust thay đổi (`run-rs-task.ts` L80).

### E2E & smoke
- **E2E TUI qua virtual terminal**: `packages/coding-agent/test/interactive-terminal-e2e.test.ts` (244 dòng) — dựng `AgentSession` + `InteractiveMode` thật, lái bằng `VirtualTerminal` import từ `../../tui/test/virtual-terminal` (L14, L50; class `VirtualTerminal implements Terminal` ở [virtual-terminal.ts L90](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/packages/tui/test/virtual-terminal.ts#L90)) — test toàn bộ đường render TUI **không cần terminal thật**. Có `ssh-url-localhost-e2e.test.ts`; Python có `python/robomp/tests/test_permissions_e2e.py`.
- **CLI smoke probe**: `--smoke-test` (spawn stats worker + tiny-model subprocess, ping rồi thoát) được nối vào `ci:test:smoke` ([package.json L131](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/package.json#L131)) và install-method tests; `AGENTS.md` L53 bắt buộc worker mới phải có smoke probe.
- `ci:test:install-methods` chạy `scripts/install-tests/run-ci.sh` (L132) — cài binary/tarball/source rồi smoke `--version`/`--help`/`stats --summary`/`--smoke-test` trong HOME cô lập.

### CI enforcement
[`ci.yml`](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/.github/workflows/ci.yml): job `native_addons` (build bazel) → **7 lane test song song**, mỗi lane một bucket + `test_smoke` (L443) + `install_methods` (L459): `test_workspace` (L328), `test_coding_agent_singleton` (L351), `test_ts_native`, `test_coding_agent_ui`, `test_coding_agent_runtime`, `test_coding_agent_native`; PR chạy ubuntu-22.04, main chạy runner `omp-kata`. Mọi lane `needs: [native_addons]`; **`release_gate` tổng hợp toàn bộ lane** trước khi publish (L484–491).

### Chống test rác — `AGENTS.md` "Testing Guidance" (L273–304), bộ quy tắc đầy đủ nhất trong ba repo
- [L275–277](https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/AGENTS.md#L275-L277): "Test the contract the system exposes — not the easiest internal detail to assert." / "Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test." / L281: "**Name the failure mode.** Every test MUST state what a consumer observes if it regresses. Cannot name one? NEVER add it."
- Good/bad filter: Good = transformation/branch-boundary/external contract/precedence-negative/regression (L282–286); **Bad: static echo** (L287), success passthrough, wording/defaults, duplicate rows (L288–291); metadata exception (L292); termination exception (L293).
- L293: cấm placeholder/tautology (`expect(true).toBe(true)`, bare `not.toThrow()`, "non-empty string checks").
- L294–295: ưu tiên contract-level; **"Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks."**
- L296–297: **full-suite safe** (không mutate lâu dài `Bun.*`/`process.env`; `vi.spyOn` + `restoreAllMocks`); **cấm `mock.module()`** (leak global registry, link oven-sh/bun#12823).
- L298–299: một test cho một invariant/transition; lỗi phải trigger **real failure path**.
- L300: "Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. 'Package boots' or 'command starts' alone is not enough."
- L302: compile-time guarantee → type test, không phải runtime placeholder.
- L303: **"Never source-grep"** — test đọc file source rồi assert trên *text* bị cấm.
- L304: "**Don't add tests for tiny low-risk changes** unless they protect a real contract or fix a regression-prone edge case."

## OpenCode (`anomalyco/opencode`, `9f69463`)

### Taxonomy & runner
- **655 file `*.test.ts`**: `packages/opencode` 249, `packages/core` 143, `packages/app` 129, `tui` 30, `llm` 30, `desktop` 15, `session-ui` 14, `console` 9, `codemode` 7, `schema` 6, `ui` 4, `client` 4, còn lại rải rác (stats, sdk-next, httpapi-codegen, enterprise, sdk, protocol, http-recorder, script).
- **Root `test` bị vô hiệu hóa có chủ đích**: [package.json L23](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/package.json#L23): `"test": "echo 'do not run tests from root' && exit 1"` — test chỉ chạy theo package qua **turbo**, và `turbo.json` **liệt kê tường minh** package nào có task `test` (`opencode#test` `dependsOn: ["^build"]`, `@opencode-ai/core#test`, `@opencode-ai/function#test`, `@opencode-ai/app#test`, `@opencode-ai/ui#test`, `@opencode-ai/session-ui#test`).
- Runner `bun test`: `packages/opencode` dùng `bun test --timeout 30000 --only-failures`; `packages/app` tách hai lane: `test:unit` = `bun test --conditions=solid --only-failures --preload ./happydom.ts ./src`, `test:browser` = `bun test --conditions=browser --preload ./happydom.ts ./test-browser` ([packages/app/package.json L22–30](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/app/package.json#L22-L30)).

### Integration setup
- **Test fixtures chuẩn hóa** (`packages/opencode/test/AGENTS.md`, 204 dòng): `tmpdir()` fixture tạo thư mục tạm `opencode-test-` tự dọn bằng `await using` (L5–13); `testEffect` + `it.effect`/`it.live`/`it.instance` cho Effect services (L~70–90); `Layer.mock` cho stub một phần — method không override sẽ `UnimplementedError` (tín hiệu đúng ý); `tmpdirScoped`/`provideTmpdirInstance`/`provideTmpdirServer`.
- **Chống flake bằng readiness signal, cấm sleep**: [L163–173](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/test/AGENTS.md#L163-L173) — "Using `Effect.sleep(N)` or `setTimeout` as a 'wait for the forked fiber to be ready' hack races the scheduler… See **PR #27622** for a concrete flake"; thay bằng `pollWithTimeout`, `awaitWithTimeout`, `llm.wait(n)` (chờ mock LLM nhận đủ n HTTP calls), `SessionStatus.Service`, `BackgroundJob.wait`, Latch/Deferred. Ngoại lệ có lý: test debounce/throttle, mtime granularity, network latency race.
- **Mock LLM server**: `packages/opencode/test/lib/llm-server.ts` (779 dòng) — HTTP server mô phỏng SSE flow (`text`/`reason`/`tool-start`/`tool-args`/`usage`), `http-error`, `hang`, `reset`; kèm `test-provider.ts`, `cli-process.ts` (spawn CLI thật), `websocket.ts`, `snapshot.ts`.
- **HTTP API exerciser**: `packages/opencode/test/server/httpapi-exercise/index.ts` [L4–9](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/test/server/httpapi-exercise/index.ts#L4-L9) — "route-coverage harness: every public route should have a small scenario that proves the route decodes requests, uses the right instance context, mutates storage when expected, and returns the expected response shape"; **cô lập `OPENCODE_DB`** (không bao giờ trỏ vào DB thật của dev); DSL `http.protected.get/post…` + `.seeded(...)` + `.at(...)` + `.json(...)` + `.mutating()`; dùng `TestLLMServer.layer` (L1796). Chạy qua `test:httpapi` với chế độ `coverage`/`auth`/`effect` và cờ `--fail-on-missing --fail-on-skip` — **bắt buộc phủ route, không được bỏ qua**.
- `test/server/AGENTS.md`: ưu tiên middleware tests với fake route nhỏ; server in-test qua `NodeHttpServer.layerTest`; **tránh `Bun.serve`** khi test Effect HTTP middleware; WebSocket qua `Socket.makeWebSocket`.

### E2E (Playwright) — hệ thống E2E duy nhất trong ba repo
- `packages/app/e2e/`: `regression/` (41 spec — đặt tên theo hành vi: `cross-server-tab-close.spec.ts`, `prompt-thinking-level.spec.ts`, `review-state-persistence.spec.ts`…), `performance/` (52), `reproduction/` (5, có `timeline-suspense/` riêng config), `smoke/` (2), `user-story/`, `utils/`.
- `packages/app/playwright.config.ts`: `testDir: "./e2e"` (L11), **`webServer` tự khởi động app** (`bun run dev -- --host 0.0.0.0 --port …`, L23–31), `retries: CI ? 2 : 0` (L20), `forbidOnly` ở CI (L19), `fullyParallel` opt-in (L18), timeout 60s/expect 10s, `trace: "on-first-retry"`, video/screenshot khi fail; project chromium duy nhất.
- **`e2e/AGENTS.md` — Test Hygiene** (L6–11): "NEVER use `waitForTimeout`, `setTimeout`, sleeps, animation-frame counts, or other wall-clock delays to synchronize a test. Wait for the specific UI state, request, response, event, or application outcome instead."; không dùng `.first()`/`.last()` để dập strictness; **không retry action thay đổi state** (retry readiness check rồi mới action); timeout adaptive; assert exact outcome để stale state không lọt.
- Yêu cầu đọc trước khi viết e2e: Playwright official Best Practices/Auto-waiting/Assertions (L1–4).

### CI enforcement & review gate
- [`test.yml`](https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/.github/workflows/test.yml): **unit job** matrix linux+windows (`GITHUB_ACTIONS=false bun turbo test`, L68) + `check:generated` (client) + `test:httpapi` (L80); **e2e job** riêng (L82) với Playwright browser cache, `bunx playwright install-deps chromium`, chạy `bun --cwd packages/app test:e2e:local` (L137) trên cả linux lẫn windows, upload `test-results` + `playwright-report`. Concurrency cancel-in-progress; nhánh chính là `dev`.
- **`pr-standards.yml`**: cho PR của người ngoài team — ép tiêu đề conventional commit (regex L88–89) và **PR phải link issue** (trừ docs/refactor/feat), gắn label `needs:title`/`needs:issue` + comment tự động. `CODEOWNERS` có sẵn.
- `.husky/pre-push`: chỉ check phiên bản bun + `bun typecheck` — **không test**. PR template hỏi "What did you test?" (CONTRIBUTING.md L201).

## So sánh chéo (cross-project patterns)

| Tiêu chí | Pi `853a80d` | OMP `65f79e7` | OpenCode `9f69463` | Wincode `54635ed` |
|---|---|---|---|---|
| Runner | Vitest/package + `node --test` scripts | `bun test` qua orchestrator riêng + cargo nextest + pytest | `bun test`/package qua turbo; Playwright cho web e2e | `bun test` (chưa có orchestrator/CI) |
| Số file test | 474 | 2.342 TS + Rust + pytest | 655 + e2e specs | 145 (125 unit + 20 integration) |
| Vị trí test | Thư mục `test/` riêng (không colocate) | `packages/*/test/` (không colocate) | `packages/*/test/` (không colocate) | **Colocate cạnh source** |
| Offline/hermetic mặc định | `PI_OFFLINE=1` + `test.sh` env -i | scrub credentials + bucket hóa | fixture tmpdir + mock LLM server | env-gate `skipIf(DATABASE_URL)` (chỉ test Postgres) |
| Model giả (seam integration chính) | faux provider (`providers/faux.ts`) | in-memory registry + VirtualTerminal | `TestLLMServer` (SSE, lỗi, hang) | chưa có (chưa cần — chưa test agent loop) |
| E2E thật | Không (evals model-backed ngoài CI) | TUI e2e qua VirtualTerminal + `--smoke-test` | Playwright `packages/app/e2e` (regression/perf/smoke) | Không có |
| CI test lane | 1 job build+check+test | 7 lane phân bucket + release_gate | unit matrix + httpapi + e2e job | **Không có CI** |
| Gate nội dung test | Regression gắn số issue (AGENTS L38) | "Testing Guidance" contract-first + anti-pattern (AGENTS L273–304) | `test/AGENTS.md` + `e2e/AGENTS.md` + httpapi fail-on-missing | CLAUDE.md L107–113 (tối thiểu) |
| Pre-commit/pre-push | check (không test) + browser-smoke có điều kiện | lint-staged/biome (không test) | typecheck (không test) | biome (không test) |
| Flake policy | suite CI-safe, e2e key-gated | `retries = 0` (nextest); retry chỉ khi bun crash | Playwright `retries: 2` CI + trace; cấm sleep | chưa có chính sách |
| Chống test rác | Triết lý "core minimal" + quy tắc regression | **Bộ quy tắc đầy đủ nhất** (L277–304) | "route-coverage" bắt buộc + hygiene e2e | chưa có văn bản |

**Pattern chung (quan sát, không phải khuyến nghị):**
1. Pre-commit/pre-push **không bao giờ chạy toàn bộ test**; test là việc của CI. Hook chỉ chặn format/lint/typecheck.
2. Determinism là ưu tiên số một: offline-by-default, credentials bị scrub, mock model thay API thật, temp dir được quản lý vòng đời.
3. Test cần môi trường ngoài (API key, DB, browser) luôn **env-gated** (`skipIf`) và nằm ngoài đường chạy mặc định — không bao giờ làm đỏ suite local vì thiếu credential.
4. Regression test gắn với số issue (Pi) hoặc đặt tên theo hành vi lỗi từng xảy ra (OpenCode `e2e/regression/`).
5. Integration được phân theo đặc tính runtime (OMP bucket hóa; OpenCode tách unit/browser/e2e; Pi tách suite/fixtures/regressions) — không trộn chung một lane.
6. "Khi nào không thêm test" được viết thành luật ở OMP; ở Pi thể hiện qua triết lý từ chối PR phình core; OpenCode qua "don't duplicate coverage" + yêu cầu đọc Playwright best practices trước khi viết e2e.
7. Mọi repo đều có một **lệnh chạy toàn bộ suite chuẩn** để CI dùng chung (Pi `npm test`, OMP `bun run test`, OpenCode `bun turbo test`).

## Khuyến nghị quản trị test cho Wincode (khuyến nghị)

Các khuyến nghị dưới đây là đề xuất của note này, dựa trên bằng chứng so sánh ở trên; phần "quan sát" đã ghi rõ ở các mục trước.

1. **Sửa ngay script `test:integration`** (package.json L39): file `integration.test.ts` ở root không tồn tại. Hai phương án: (a) tạo `integration.test.ts` root import toàn bộ 20 file integration, hoặc (b) đổi script thành `bun test apps/cli/src apps/server/src apps/web/src packages/ai/src packages/billing/src --filter "*.integration.test.ts"` (lọc theo tên, theo mô hình `test:postgres`). Phương án (b) ít ma thuật hơn.
2. **Định nghĩa ba nấc integration thành văn bản** (README/`AGENTS.md` ngắn): (1) `*.integration.test.ts` in-process (composition seam — mẫu `api.integration.test.ts`), (2) real-IO (subprocess/fs/SQLite — mẫu `runner.integration.test.ts`), (3) external-service env-gated (mẫu `repository.postgres.test.ts` + `describe.skipIf`). Quy ước: nấc 3 luôn có cờ skip và không nằm trong lane mặc định.
3. **Thêm CI lane tối thiểu** (Wincode là repo duy nhất trong bốn repo không có `.github/workflows`): job `test` chạy `bun install --frozen-lockfile && bun run check-types && bun test` (tương đương Pi ci.yml); job `test:postgres` riêng với service container Postgres + `DATABASE_URL` (tương đương OpenCode tách e2e khỏi unit); yêu cầu branch protection. Đây là khoảng trống lớn nhất so với cả ba upstream.
4. **Chép khuôn khổ chống test rác từ OMP `AGENTS.md` L275–304** vào `AGENTS.md` của Wincode, mục Testing (thay phần hướng dẫn tối thiểu hiện tại): contract-first + "name the failure mode" + cấm static echo/source-grep/tautology + full-suite safe + **không thêm test cho thay đổi nhỏ rủi ro thấp** + không duplicate coverage giữa các nấc. Bộ quy tắc này đã được OMP vận hành thực tế trên chính `bun test`, nên áp dụng nguyên văn cho Wincode mà không cần dịch chuyển runner.
5. **Quy ước regression gắn số issue** theo Pi (AGENTS L38 + thư mục `test/suite/regressions/`): tên file hoặc comment kèm `#<issue>`; đồng thời dùng `diagnosing-bugs` (Phase 5) làm chuẩn cho việc viết regression test tại seam đúng.
6. **Giữ Bun test runner; không đưa vitest vào** trừ khi một package cần (upstream chỉ dùng vitest khi đã có sẵn từ trước; Wincode đã thuần `bun test`). Áp dụng cờ `--only-failures` và `--timeout` (OpenCode dùng `--timeout 30000`; OMP 30s) để CI log gọn và chặn hang.
7. **Vệ sinh hermetic**: giữ `skipIf(!DATABASE_URL)`; khi có CI, scrub `*_API_KEY`/`*_OAUTH_TOKEN` khỏi env test (mẫu OMP `SCRUBBED_ENV_*`); mặc định offline cho test gọi network (mẫu Pi `PI_OFFLINE=1` + `allowNetwork()` opt-in).
8. **Flake policy**: unit/integration **không retry** (mẫu OMP `retries = 0`); nếu sau này có Playwright e2e thì theo OpenCode (`retries: 2` ở CI + `trace: on-first-retry` + cấm `waitForTimeout`). Chống flake bằng readiness signal (OpenCode test/AGENTS.md L163–173) — đặc biệt đúng cho test agent loop tương lai.
9. **Khi nào không thêm test** (ghi vào CLAUDE.md): thay đổi nhỏ rủi ro thấp (OMP L304); plumbing thuần/passthrough; "package boots" smoke (OMP L300); test đọc text source (OMP L303); test trùng contract đã có ở nấc khác (OMP L295).
10. **E2E tương lai theo nhu cầu, không theo phong trào**: TUI của `apps/cli` (opentui) nên test theo mẫu OMP `VirtualTerminal` (không cần tmux/PTTY thật); web `apps/web` chỉ thêm Playwright khi có user-flow thật cần bảo vệ (mẫu OpenCode `packages/app/e2e` + `webServer` tự khởi động + `e2e/AGENTS.md`). CLI smoke (`--version`/`--help` + một probe runtime) theo mẫu OMP `ci:test:smoke`.

## Skill OMP hiện có trong môi trường, áp dụng được ngay (đã xác minh cài đặt qua `skill://`)

Các skill sau **có trong registry của môi trường này** (đọc được qua `skill://<tên>`), không phải suy đoán:

| Skill | Nội dung cốt lõi | Khớp với bằng chứng upstream nào |
|---|---|---|
| `tdd` | Red→green; test ở **seam** đã thống nhất; anti-pattern implementation-coupled/tautological/**horizontal slicing** | Khớp OMP L277–295 (contract-first, cấm tautology, không duplicate coverage); khớp triết lý Pi "core minimal" |
| `vitest` | Vitest 5.x: config, mocking, coverage, environments, type testing | Chỉ cần nếu Wincode nhận vitest (không khuyến nghị hiện tại); Pi dùng vitest + `vitest-evals` |
| `playwright-best-practices` | E2E: locators, auto-waiting, web-first assertions, flake fixes, CI/CD, test tags | Khớp trực tiếp OpenCode `e2e/AGENTS.md` (cấm sleep, web-first assertions, trace) — dùng khi triển khai e2e web |
| `diagnosing-bugs` | Feedback loop red-capable; Phase 5: regression test **trước** fix tại seam đúng | Khớp Pi `test/suite/regressions/` + OMP "trigger the real failure path" (L299); là chuẩn viết regression cho Wincode |
| `verification-before-completion` | Evidence trước claim; không nói "pass" khi chưa chạy | Khớp văn hóa CI gate của cả ba upstream (check + test là điều kiện giao nộp, không phải lời hứa) |

## Kế hoạch áp dụng theo giai đoạn (khuyến nghị)

- **Giai đoạn 1 (tuần 1) — nền móng, chi phí thấp**: sửa script `test:integration` (L39); thêm `.github/workflows/test.yml` với 2 job (`bun test` toàn repo; `test:postgres` có service Postgres); ghi 3 nấc integration + quy tắc contract-first/anti-pattern tóm tắt vào `AGENTS.md` mục Testing; thống nhất `--only-failures --timeout 30000` trong scripts.
- **Giai đoạn 2 (tuần 2–3) — kỷ luật**: quy ước regression gắn số issue (Pi); `bun test --filter "*.integration.test.ts"` làm lane integration tường minh; thêm CLI smoke probe cho `apps/cli` (mẫu OMP `--smoke-test`); scrub credential env trong workflow.
- **Giai đoạn 3 (1–2 tháng) — mở rộng theo nhu cầu**: nếu có agent-loop/session logic mới, dựng mock model provider (mẫu Pi faux provider / OpenCode TestLLMServer) làm seam integration; TUI test qua virtual terminal (mẫu OMP); chỉ thêm Playwright e2e cho `apps/web` khi có user-flow cần bảo vệ, kèm `e2e/AGENTS.md` riêng.
- **Thường trực**: PR checklist "What did you test?" (mẫu OpenCode template); flake = bug (không retry ở lane unit/integration); dùng `verification-before-completion` trước mọi claim hoàn thành.

## Nguồn (đã dẫn chiếu ở trên)

**Pi — earendil-works/pi @ `853a80d`** (lưu ý: `badlogic/pi-mono` → 301 → `earendil-works/pi`, xác minh 2026-08-31):
1. package.json — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/package.json#L29-L34
2. test.sh — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/test.sh
3. .github/workflows/ci.yml — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/.github/workflows/ci.yml#L14-L42
4. .github/workflows/pr-gate.yml — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/.github/workflows/pr-gate.yml
5. .husky/pre-commit — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/.husky/pre-commit
6. AGENTS.md — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/AGENTS.md#L31-L38
7. CONTRIBUTING.md — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/CONTRIBUTING.md#L60-L64
8. packages/coding-agent/test/suite/README.md — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/test/suite/README.md#L3-L9
9. packages/coding-agent/vitest.config.ts — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/coding-agent/vitest.config.ts#L11-L13
10. packages/evals/README.md — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/evals/README.md#L3-L6
11. packages/ai/test/anthropic-long-cache-retention-e2e.test.ts — https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/test/anthropic-long-cache-retention-e2e.test.ts#L122

**OMP — can1357/oh-my-pi @ `65f79e7`**:
12. package.json — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/package.json#L97-L143
13. scripts/ci-test-ts.ts — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/scripts/ci-test-ts.ts#L139-L215, #L381-L434, #L447-L459
14. AGENTS.md — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/AGENTS.md#L253, #L273-L304
15. .config/nextest.toml — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/.config/nextest.toml#L22-L23
16. .github/workflows/ci.yml — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/.github/workflows/ci.yml#L328-L491
17. packages/coding-agent/test/interactive-terminal-e2e.test.ts — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/packages/coding-agent/test/interactive-terminal-e2e.test.ts#L14-L50
18. packages/tui/test/virtual-terminal.ts — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/packages/tui/test/virtual-terminal.ts#L90
19. scripts/install-tests/run-ci.sh — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/scripts/install-tests/run-ci.sh
20. scripts/run-rs-task.ts — https://github.com/can1357/oh-my-pi/blob/65f79e76fcc89b96632fe86a598f314bd7cfc725/scripts/run-rs-task.ts#L80

**OpenCode — anomalyco/opencode @ `9f69463`**:
21. package.json — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/package.json#L23
22. packages/app/package.json — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/app/package.json#L22-L30
23. .github/workflows/test.yml — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/.github/workflows/test.yml#L24-L137
24. .github/workflows/pr-standards.yml — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/.github/workflows/pr-standards.yml#L88-L93
25. packages/app/e2e/AGENTS.md — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/app/e2e/AGENTS.md#L6-L11
26. packages/app/playwright.config.ts — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/app/playwright.config.ts#L11-L31
27. packages/opencode/test/AGENTS.md — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/test/AGENTS.md#L5-L13, #L163-L173
28. packages/opencode/test/server/AGENTS.md — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/test/server/AGENTS.md
29. packages/opencode/test/server/httpapi-exercise/index.ts — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/test/server/httpapi-exercise/index.ts#L4-L22
30. packages/opencode/test/lib/llm-server.ts — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/packages/opencode/test/lib/llm-server.ts#L1-L60
31. turbo.json — https://github.com/anomalyco/opencode/blob/9f69463f1d556af2b5b51d2efa1c04f5f544f911/turbo.json

**Wincode — sonwjnn/wincode, HEAD cục bộ `54635ed`** (repository evidence, đường dẫn + dòng trong repo):
32. package.json L37–40 (scripts test) · lefthook.yml · bunfig.toml · AGENTS.md (mục Testing)
33. apps/server/src/routes/api.integration.test.ts L1–31 (in-process Hono composition với subrouter stub)
34. packages/ai/src/tools/shell/runner.integration.test.ts L1–73, L83–237 (subprocess/fs thật, temp dir, timeout, truncation)
35. apps/server/tests/integration/billing/repository.postgres.test.ts L1–63, L93 (`describe.skipIf(!hasDatabaseUrl)`, Postgres thật, UUID prefix)
36. Đếm file test bằng `git ls-files`: 145 `*.test.ts(x)` (125 unit + 20 integration; 19 file tên `*.integration.test.ts`); không có `.github/`, không có config Playwright/Vitest, không có `*.e2e.*`/`*.spec.*`.

**Môi trường (skills, xác minh qua `skill://`)**: `tdd`, `vitest`, `playwright-best-practices`, `diagnosing-bugs`, `verification-before-completion` — tất cả có mặt trong registry skill của môi trường hiện tại.
