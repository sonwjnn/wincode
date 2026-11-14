# Test quality review, 2026-11-14

Scope: whole repository, sampled. Bun test suite (`packages/*/test`), plus the
application code those tests cover, reviewed for testability.

Method: quantify, sample, run, mutate. Every claim below is backed by a command
result recorded in this file. All fourteen findings were fixed; [Fixes
applied](#fixes-applied) lists the diff and the re-verification.

```
bun run test                 # 3 independent runs, all exit 0
bun test <file>              # targeted reruns for the flakiness and sleep probes
bun check                    # ultracite: clean
bun scripts/test-smell-check.ts
```

## Evidence base

| Check | Result |
| --- | --- |
| Suite green, run 1/2/3 | 262 files, 2550 tests, 0 failures each run (`/tmp/test-run-{1,2,3}.log`) |
| Discovery | 271 test files: 262 default, 9 e2e (`scripts/test-discovery.ts`) |
| Wall time | ~110 s; `coding-agent` alone 107.3 s for 2131 tests |
| Per-test timing | 2 tests >= 10 s, 1 >= 5 s, 16 >= 1 s, 31 >= 500 ms |
| Flakiness | 0 failures across 3 full runs and 6 parallel targeted runs |
| Post-fix verification | 6 full `bun run test` runs across both fix passes, all exit 0 (latest: 262 files, 0 failures); `bun check`, `bun check-types`, and the ratchet gate exit 0 |
| Mutation probe | Stryker 10 + `@hughescr/stryker-bun-runner`, see [mutation probe](#mutation-probe) |

## Suite shape

| Package | Files | Tests | LOC | Classification |
| --- | --- | --- | --- | --- |
| `coding-agent` | 216 | 2125 | 106 197 | 207 default, 9 e2e |
| `ai` | 24 | 176 | 10 455 | default |
| `mcp` | 9 | 64 | 1873 | default |
| `utils` | 9 | 43 | 692 | default |
| `subagents` | 7 | 29 | 1334 | default |
| `agent-core` | 6 | 78 | 3260 | default |
| **Total** | **271** | **2515** | **123 811** | |

Suite-wide grep counts: 124 fixed-wait references in 40 files; 1459 conditional
statements in 163 files; 878 boolean-only assertions in 125 files.

Those three numbers overstate the problem, and the sample proves it:

- The 878 boolean-only assertions are dominated by predicate tables
  (`packages/utils/test/scalar-predicates.test.ts`, 47 hits). `toBe(false)` on
  `isJsonValue(cyclic)` is the honest assertion; there is no richer value to
  show. This is not a diagnostic smell.
- The 1459 conditionals are mostly `for` loops that generate one named test per
  table row (`packages/ai/test/sdk-provider-conformance.test.ts:134`) and
  fixtures that build data. Test-name tables are the recommended fix, not the
  smell.
- Only the fixed waits survived scrutiny as a systemic problem, and even there
  the distinction matters: a polling loop with a deadline
  (`waitForFrame`, `session-history-tree-tmux.e2e.test.ts:83`) is fine; a fixed
  sleep as the only synchronization is not.

Verdict: the suite is materially better than typical. Assertions are specific,
fakes sit at boundaries, and names state behavior and condition. Three
high-severity and six medium-severity problems are worth fixing, in this order.

## Summary of findings

| ID | Severity | Smell | File | Status |
| --- | --- | --- | --- | --- |
| F1 | High | Tests that assert the fixture, not production behavior | `packages/agent-core/test/contracts.test.ts:142,270,370` | Fixed |
| F2 | High | Fixed sleep as the only synchronization | `packages/coding-agent/test/clipboard-selection-interactions.test.tsx` (10 sites) | Fixed, 10 removed |
| F3 | High | `Bun.sleep(0)` racing an unexposed async completion | `packages/subagents/test/task-runtime.test.ts` (3); `packages/coding-agent/test/mcp/registry.test.ts` (9) | Fixed, 12 removed |
| F4 | Medium | Abort assertion after the only meaningful step | `packages/mcp/test/client.test.ts:347` | Fixed |
| F5 | Medium | Empty-manifest fallback `?? ""` hides the real failure | `packages/coding-agent/test/mcp/registry.test.ts` (14 sites) | Fixed |
| F6 | Medium | Wall-clock branches with no seam and no test | `packages/coding-agent/modules/sessions/storage/versioned-editing-store.ts:325-328,402-437,455-466` | Fixed |
| F7 | Medium | Timing asserted by inequality because the clock is not injectable | `packages/agent-core/src/agent-runtime.ts` (7 `Date.now()` sites); test at `agent-runtime.test.ts:731` | Fixed |
| F8 | Medium | Export half of a module untested | `packages/utils/src/guards.ts` (`isNumber`, `isInteger`, `isLength`, `isArrayLike`) | Fixed |
| F9 | Medium | A table loop can silently delete a test | `packages/ai/test/sdk-provider-conformance.test.ts:188` | Fixed |
| F10 | Low | 131 tests, 11 793 lines, zero `describe` grouping | `packages/coding-agent/test/sessions/session-jsonl-sdk.test.ts` | Fixed, 15 groups |
| F11 | Low | `JSON.stringify(...)` substring assertions | `packages/coding-agent/test/mcp/registry.test.ts` (e.g. 463, 492, 509) | Fixed |
| F12 | Low | Negated assertion passes for any other wrong value | `packages/ai/test/model-contracts.test.ts:263` | Fixed |
| F13 | Low | Repeated inline capture boilerplate | `packages/coding-agent/test/sessions/submit.test.ts` (4 identical blocks) | Fixed |
| F14 | Low | `toThrow` then re-invoke to inspect the cause | `packages/agent-core/test/tools.test.ts:133-140` | Fixed |

## Readability

- **F10 (low).** `session-jsonl-sdk.test.ts` is one flat list of 131 tests over
  11 793 lines. Finding the fork tests means scrolling past the plugin-history
  tests. Fix: add `describe` blocks per domain (plugin history, navigation,
  fork/import/export, projection rebuild) without moving code — `bun test -t`
  then selects a domain. This is navigation cost only; individual tests read
  well.
- **F13 (low).** `submit.test.ts` repeated the same five-line
  `submissions.push({ ...("skill" in submission ... ) })` capture block four
  times (plus one composition capture with a different shape). Fix: one
  `captureSubmissions()` helper next to `createDependencies`. A change to the
  submission shape used to mean four identical edits.
- No mystery guests found. Fixtures are named and local; no external JSON blob
  is required to read an assertion.

## Reliability

- **F2 (high), fixed sleep as the only synchronization.**
  `clipboard-selection-interactions.test.tsx` calls `await Bun.sleep(20)` ten
  times immediately after `act(...)` and *before* `flush(setup)`. Nothing gates
  the work being waited for; 20 ms is a guess about how long the renderer takes.
  Why it matters: the guess is machine-dependent, and when it fails it fails as
  "clipboard.writes was `[]`" on an unrelated PR. Evidence it is unnecessary:
  removing all ten sleeps leaves the file green 3/3 sequentially and 6/6 under
  six concurrent runs (`/tmp/nosleep-load-*.log`). Fix: delete the sleeps; the
  existing `flushTestRenderer` / `await act(...)` already settles the update.
  This file alone costs ~200 ms of dead wall time per run and teaches the wrong
  pattern to whoever copies it next.
- **F3 (high), tick-based waits on unexposed async work.**
  `task-runtime.test.ts:85` and `:129` and `:199` call `await Bun.sleep(0)`
  after `coordinator.onSessionStart(...)`, then assert
  `listPendingReports(parentSessionId)` is empty. The coordinator exposes no
  "recovery drained" promise, so the test waits one microtask tick and hopes
  the delivery pass finished. Add one `await` inside the coordinator's recovery
  loop and these tests flip. The same pattern appears nine times in
  `mcp/registry.test.ts` (e.g. `:807`, `:836`, `:1076`) to let a reconnect
  start before toggling. Fix: return a completion promise from the public
  operation (`onSessionStart` -> `Promise<void>`; `reconnect` already returns a
  promise in the registry case, so `await` the state, not a tick).
- No order dependency: every test reviewed creates its own temporary root,
  database path, or in-memory store. No test reads shared mutable state left by
  another.
- No real external service calls found. Provider transports are always injected
  (`createFakeTransport`, `sdk-provider-conformance.test.ts:73`), and
  `mcp/client.test.ts` injects both transports plus `createStartupSignal`.
- The tmux e2e file is well-built: bounded polling (`waitForFrame`), retries with
  explicit failure descriptions (`sendPrompt` explains the swallowed-Enter
  case). Not a finding.

## Diagnostic value

- **F5 (medium), fallback masks the failure.**
  `snapshot.manifest[0]?.name ?? ""` appeared 14 times in
  `mcp/registry.test.ts`. If a regression empties the manifest, the test passed
  `""` into `execute(...)` and fails on "Unknown MCP tool" — pointing at tool
  dispatch instead of at the manifest the test just asserted was non-empty. Fix:
  a `manifestName(snapshot)` helper that throws
  `"Expected a manifest entry for demo"`, or `const [entry] = snapshot.manifest;
  if (entry === undefined) throw new Error(...)`. Same pattern in the same file
  at `:439`, `:460`, `:489`.
- **F11 (low).** `expect(JSON.stringify(result.content)).toContain("changed
  after reconnect")` (`registry.test.ts:651`, also `:463`, `:492`, `:509`)
  reports a giant JSON blob on failure and cannot distinguish
  "right message, wrong shape" from "wrong message". Fix:
  `expect(result).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringContaining("changed after reconnect") }] })`.
- **F12 (low).** `expect(...).not.toBe("context-overflow")`
  (`model-contracts.test.ts:263`) passes if the classifier returns
  `authentication`. State the expected code.
- **F14 (low).** `tools.test.ts:133-140` asserts `toThrow` and then re-invokes in
  a `try/catch` to inspect `cause`. Two calls, two chances to differ. Fix: one
  `try/catch` with `expect(error).toMatchObject({ cause: "write" })`.
- Multi-behavior tests: present (e.g. `registry.test.ts` reconnect tests assert
  status, call count, and connection count). Accepted here — each asserts one
  state transition plus its guard, and splitting would duplicate a 40-line
  setup. Worth watching, not worth changing.

## Design

- **Over-mocking: none found.** Fakes implement the real interface
  (`FakeMcpClient implements McpClient`), value objects are built with factories
  (`serverConfig`, `tool`), and pure functions are called directly.
- **Conditional test logic: mostly table generation.** Two genuine instances:
  - `sdk-provider-conformance.test.ts:188` (**F9, medium**):
    `if (knownModelId !== undefined) { test(...) }`. `knownModelId` is
    `expectedModelIds[0]`. If a factory's table entry loses its model list, the
    credentials test silently disappears and the suite stays green. That is a
    test that deletes itself. Fix: assert `expectedModelIds.length > 0` for every
    non-discoverable factory before generating tests, or make the field
    `readonly [string, ...string[]]`.
  - `lifecycle.test.ts:73-89` re-derives the expected status from the terminal
    event with a `switch`. It is a small mapping table, not untested branching;
    acceptable.
- **Fixture size** is proportional: `harness()` in `registry.test.ts` builds two
  objects and takes overrides. No 20-object `beforeEach` found.

## AI-generated test smells

The catalogue's tells were checked directly:

- Hallucinated locators: N/A (no browser). TUI tests use real components and
  `mockInput`/`mouse`, not invented test ids.
- Fabricated imports: `bun check` type-checks clean, and every helper imported in
  the reviewed files exists (`fromAny`/`fromPartial` are real
  `@total-typescript/shoehorn` exports).
- Generic data: none. Fixtures use domain values (`claude-opus-5.5`,
  `web_search_exa`, `terminal-smoke/fake`), not `test@test.com`/`John Doe`.
- Project-convention drift: none visible; the reviewed files match the repo's
  contract-first naming ("`<behavior> when <condition>`" is used, not
  "should ...").
- Closed AI loop is unverifiable from the tree, so the objective proxy was used:
  mutation score, below. The mixed result — weak constraint where the tests
  describe the fixture (`agent-core/test/contracts.test.ts`, 47.9 % on
  `turn.ts`) and full constraint where behavior is asserted (`utf8.ts`, 100 %) —
  is the useful signal regardless of who wrote the code.

## Coverage

- **F8 (medium), untested exports.** `packages/utils/src/guards.ts` exports 17
  predicates. `isNumber`, `isInteger`, `isLength`, `isArrayLike` have zero
  references in any `packages/*/test` file. The mutation run gives the size:
  56 no-coverage mutants in a 65-line module. Fix: either delete the unused
  predicates or add the four one-line table entries to
  `scalar-predicates.test.ts` (the file already has the shape for it).
- **F6 (medium), wall-clock branches.** `versioned-editing-store.ts` has three
  time-dependent behaviors with no test reference anywhere:
  `PATH_LEASE_MAX_WAIT_MS = 5000` timeout (`pathLeaseTimeout`),
  `PATH_LEASE_DURATION_MS = 30_000` expiry with a 10 s heartbeat
  (`pathLeaseLost`), and `SNAPSHOT_PRUNE_GRACE_MS = 30_000` prune grace. Zero
  matches for `pathLeaseTimeout`/`pathLeaseLost` in `packages/*/test`. These are
  multi-writer correctness paths — the exact failure mode a second wincode
  instance hits. Fixed by injecting `FileObservationClock` (`now`, `delay`,
  `onInterval`) and adding the timeout, lease-loss, and prune-boundary tests.
- **F4 (medium), assertion stops before the behavior.** `client.test.ts:347`
  ("combines a caller signal with the startup signal") asserts the combined
  signal is an `AbortSignal` and not yet aborted, dispatches `abort` on the
  caller, and asserts nothing afterwards. An implementation that ignores the
  caller signal passes. Fix: assert `combined?.aborted` is true after
  `dispatchEvent`, and that the SDK connect promise rejects.
- Happy-path bias: not present. Error paths are the majority in `mcp/client.ts`
  and `ai/test/model-contracts.test.ts` (sanitization, timeouts, aborts,
  408/413/429 classification). Boundary values are tested for byte limits (`é`
  at 1 and 2 bytes), integer edges (`MAX_SAFE_INTEGER + 1`), and pagination
  cursors.

## Testability analysis

Four seams decide how expensive the tests above are. Two places in this repo
already do it right, which makes the gaps cheap to close by imitation.

### 1. Clock injection

Problem: `agent-runtime.ts` reads the wall clock at seven sites and sleeps
directly (`agent-runtime.ts:539,725,1176,1722,1753,1858,1977`;
`sleep(decision.delayMs, ...)` at `:1194`). A retry test therefore cannot say
what `retryAt` is; it says `retryAt >= failedAt + 25`
(`agent-runtime.test.ts:731`), which passes for any delay above the lower bound,
including a wrong 60 s. `versioned-editing-store.ts` has the same shape with
`Date.now()` deadlines and `setInterval` heartbeats, which is why its timeout
paths have no tests at all.

Fix, following an existing repo precedent — `createSubagentsTaskStore(":memory:", { now })`
already injects the clock (`task-runtime.test.ts:101`):

```ts
// before
const retryAt = Date.now() + decision.delayMs;
await sleep(decision.delayMs, undefined, { signal: options.signal });

// after
type AgentRuntimeDeps = { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> };
const retryAt = deps.now() + decision.delayMs;
await deps.sleep(decision.delayMs, options.signal);
```

The test then asserts `retryAt === 1_700_000_000_025` exactly and advances a
fake clock instead of waiting. Implemented as `RuntimeClock`
(`now`, `sleep`) passed through `createAgentRuntime({ clock })`; the same seam
shape is now `FileObservationClock` in `versioned-editing-store.ts`.

### 2. Completion seam for fire-and-forget work

Problem: `getSubagentsTaskCoordinator(...).onSessionStart(context)` starts
recovery without returning anything awaitable, so three tests tick with
`Bun.sleep(0)` and then assert a post-condition of work they cannot observe
(F3).

Fix: return the promise.

```ts
// before
onSessionStart(context: PluginSessionContext): void

// after
onSessionStart(context: PluginSessionContext): Promise<void>
```

The test becomes `await coordinator.onSessionStart(ctx);` and the assertion is
no longer a race. Cost is one `return` in the coordinator; no production call
site needs to change if it ignores the promise today.

### 3. Interface segregation

Problem: `SessionSdkOperations` (`modules/sessions/sdk-contract.ts:321`) is a
13-method `Pick<SessionSdk, ...>`. The subagents coordinator uses 6
(`deliverToSession`, `createSessionRuntime`, `openSession`,
`createEmptySession`, `getAgentCatalog`, `dispose`). Every test double must
therefore satisfy methods it never calls: 373 `fromPartial<...>` casts across
the test tree, which is a compile-time escape hatch that also disables checking
of the parts that *are* used.

Fix: declare the narrow capability each consumer needs and accept that.

```ts
// before
const coordinator = getSubagentsTaskCoordinator(taskStore, pluginFactory);
// context: SessionSdkOperations (13 methods)

// after
export type TaskSessionPort = Pick<SessionSdkOperations,
  "deliverToSession" | "createSessionRuntime" | "openSession" |
  "createEmptySession" | "getAgentCatalog" | "dispose">;
```

Tests then implement 6 methods with no cast. The repo already demonstrates the
pattern one layer down: `FileObservationStore` lets
`tools-versioned-editing.test.ts:1103` test lease ordering with a small fake,
while the store behind it was untestable before F6 added the clock seam.

### 4. Pure function extraction

No new finding. `preparePromptSubmission(dependencies, snapshot)` in
`modules/sessions/hooks/input-controller/submit.ts` is the counter-example to
copy: inputs, dependencies, and the decision are separate, so 19 tests cover
marker stripping, paste expansion, and rejection without a renderer or a
transport. `submit.test.ts` is the cheapest file in the sample to read.

## Mutation probe

Feasibility question: can any mutation runner drive `bun test` here? Yes.

- `@stryker-mutator/command-runner` does not exist (404 on npm), so the
  generic-command route is out.
- `@hughescr/stryker-bun-runner@1.6.0` (Apache-2.0, published 2026-10-13) is a
  real Stryker 10 test runner for `bun test` with per-test coverage.
- Nothing was added to this repository: the probe ran in `/tmp/mut-probe*`
  against copies of the source and tests, with `reports/mutation.json` as the
  output.

Config that worked:

```js
export default {
  appendPlugins: ["@hughescr/stryker-bun-runner"],
  testRunner: "bun",
  coverageAnalysis: "perTest",
  mutate: ["src/guards.ts"],
  reporters: ["clear-text", "json"],
  concurrency: 4,
};
```

Results:

| Target | Test set | Mutation score | Covered | Killed | Survived | No coverage |
| --- | --- | --- | --- | --- | --- | --- |
| `utils/src/guards.ts` + `utf8.ts` | `scalar-predicates.test.ts` | 48.78 % | 89.55 % | 60 | 7 | 56 |
| — after the F8 fix, same file | same | 70.73 % | 94.57 % | 87 | 5 | 31 |
| — after the F8 fix, all utils tests | `packages/utils/test/*` | 98.37 % | 98.37 % | 121 | 2 | 0 |
| — `utf8.ts` alone | `scalar-predicates.test.ts` | 100 % | 100 % | 10 | 0 | 0 |
| `agent-core/src/turn.ts` | `contracts.test.ts` only | 47.87 % | 77.10 % | 101 | 30 | 80 |
| `agent-core/src/turn.ts` | `contracts.test.ts` only, after the F1 fix | 81.52 % | 92.47 % | 172 | 14 | 25 |
| `agent-core/src/turn.ts` | all 6 `agent-core` test files | 57.74 % | 61.33 % | 138 | 87 | 14 |

Reading the numbers honestly:

- The `guards.ts` score was depressed by untested exports, not by weak
  assertions: `isNumber`, `isInteger`, `isLength`, `isArrayLike` accounted for the
  56 no-coverage mutants. After the F8 fix the same file reaches 98.2 % with the
  whole package suite, and the only 2 survivors are `typeof value === "number"`
  guards in front of `Number.isFinite`/`Number.isInteger`, which already refuse
  non-numbers (equivalent mutants). Note the residual 31 no-coverage mutants when
  only `scalar-predicates.test.ts` runs: those are exports this file does not
  import (`isObjectLike`, `isNull`, `isBoolean`, `isArray`, ...), covered by the
  package's other test files. A per-file mutation score cannot see that.
- The `turn.ts` gap is real and specific. `contracts.test.ts` was enough to
  cover the file (77 % covered) but left 30 mutants alive, concentrated in the
  tool-part allowlists (`turn.ts:193-222`). Sample survivor:
  `Object.keys(value).every((key) => key === "output" || ...)` mutated to
  `some(...)`. Nothing in the test passed an unknown key, so an extra-key
  rejection regression shipped green. After the fix the same test file reaches
  81.5 % total / 92.5 % covered with 14 survivors (from 30), and the remaining
  survivors are masked `||` clauses inside the same allowlists, not untested
  behavior.
- The all-tests row shows a different trade-off: the whole `agent-core` suite
  kills more mutations (138) but covers fewer lines of `turn.ts` per file, and
  it still leaves 87 alive. Per-file scores in a 2000-line module are a
  prioritization signal (``this file has weak coverage of X``), not a gate
  number.

Reproducing costs about 30 s per target after a one-time
`bun add -d @stryker-mutator/core @hughescr/stryker-bun-runner` in a scratch
directory. It is not wired into CI because that requires a dependency decision
(see next actions).

## Automated gate

The recurring smell with the cheapest mechanical check is the fixed wait, so it
is now enforced as a ratchet instead of a review comment:

- `scripts/test-smell-check.ts` counts `Bun.sleep(`, `waitForTimeout(`,
  `setTimeout(` per test file and fails when a file exceeds its recorded count.
- `docs/test-smell-baseline.json` records the current 102 occurrences across 37
  files (down from 124 across 40 after the F2/F3 fixes). Existing waits do not
  fail the build; a new one does, and deleting a wait lowers the ceiling.
- `scripts/test-smell-check.test.ts` holds six contract tests (regression
  detected, unrecorded file with a wait, at-or-below baseline, invalid baseline
  entry, collected counts, and a live check against this repository) and runs in
  the existing `test:scripts` lane, so `bun run test` enforces it with no
  config change. `scripts/test-discovery.ts` exempts it from the
  `packages/<package>/test` placement rule next to the existing
  `test-portfolio.test.ts` exemption, because it is a repository-level gate
  rather than package coverage.

Verified end to end: appending one `Bun.sleep(5)` to
`packages/utils/test/json.test.ts` fails the check with
`new at line 11`; restoring the file makes it pass again. `bun check` is clean.

Why not an ESLint/Biome rule instead: the repo still has 102 legitimate-or-tolerated
occurrences including deadline polling loops, and a blanket ban would be turned
off on day one. A ratchet changes future code without relitigating the past.

## Per-file findings

Rows are the files read in depth. Severity is for the file's own findings, not
for the suite.

| File | Lines | Depth | Severity | Findings |
| --- | --- | --- | --- | --- |
| `coding-agent/test/sessions/session-jsonl-sdk.test.ts` | 11 793 | targeted | Low | F10 fixed: 15 `describe` groups over 132 tests |
| `coding-agent/test/sessions/session-history-tree-tmux.e2e.test.ts` | 939 | targeted | None | Bounded polling, retry rationale documented |
| `coding-agent/test/mcp/registry.test.ts` | 1420 | full | Medium | F3, F5, F11 fixed; 41 tests green |
| `coding-agent/test/sessions/submit.test.ts` | 661 | full | Low | F13 fixed; 19 tests green |
| `coding-agent/test/clipboard-selection-interactions.test.tsx` | 231 | full | High | F2 fixed; 10 sleeps removed |
| `ai/test/sdk-provider-conformance.test.ts` | 355 | full | Medium | F9 fixed; 23 tests green |
| `ai/test/model-contracts.test.ts` | 293 | full | Low | F12 fixed |
| `mcp/test/client.test.ts` | 641 | full | Medium | F4 fixed; 20 tests green |
| `agent-core/test/contracts.test.ts` | 410 | full | High | F1 fixed and boundary tests added; 14 tests green |
| `agent-core/test/tools.test.ts` | 147 | full | Low | F14 fixed |
| `agent-core/test/lifecycle.test.ts` | 204 | full | Low | Expected-status `switch` duplicates the mapping (accepted) |
| `subagents/test/task-runtime.test.ts` | 479 | full | High | F3 fixed; coordinator now awaitable, 29 tests green |
| `utils/test/scalar-predicates.test.ts` | 87 | full | Medium | F8 fixed; 4 predicates added, 13 tests green |
| `utils/test/json-predicates.test.ts` | 75 | full | None | Boundary and negation cases are complete |

F1 in detail (high): three tests in `contracts.test.ts` assert data the test
itself constructed and call nothing under test.

- `:270` "keeps different Session Turn executions distinct" builds `parent` and
  `subagentTurn` with different literal ids, then asserts
  `subagentTurn.id !== parent.id`. No production function decides that
  distinctness here; if the runtime collapsed two turns into one, this test
  would still pass.
- `:370` "is fully resolved for one runtime invocation" builds a `satisfies
  AgentTurn` object and asserts its own fields. The `satisfies` clause is the
  only real check, and it is a compile-time one.
- `:142` "every event carries Agent Turn identity and a monotonic sequence"
  asserts `typeof event.turnId === "string"` on events produced by the local
  `baseEvent` fixture. The production assertion in that test is
  `isAgentTurnEvent(event)`, which the next test covers properly.

Why it matters: these three inflate the perceived coverage of the Agent Turn
contract and cost maintenance when the fixture changes. Fix: delete `:270` and
`:370`, and reduce `:142` to the `isAgentTurnEvent` loop. The real contract is
already covered by the malformed-input tests in the same file and by
`lifecycle.test.ts`.

## Fixes applied

| ID | Change | Verification |
| --- | --- | --- |
| F1 | Deleted the two fixture-only tests, reduced the third to its production assertion (`contracts.test.ts`), and added unknown-key plus text/file part allowlist cases | 14 tests green; `turn.ts` mutation score 47.9 % -> 81.5 % with the same test file |
| F2 | Removed all 10 `Bun.sleep(20)` calls from the clipboard test | 8 tests green 3/3 sequential and 6/6 under parallel load |
| F3 | `SubagentsTaskCoordinator.onSessionStart` now returns `Promise<void>`; tests `await` it. Replaced all 9 `Bun.sleep(0)` ticks in `registry.test.ts` with deferred signals from the injected fakes | subagents 29/29, registry 41/41 green; zero fixed waits left in either file |
| F4 | The signal-combination test now aborts the controller and asserts `combined.aborted === true` | 20 tests green |
| F5 | Added `manifestToolName()`; all 14 `manifest[0]?.name ?? ""` fallbacks now throw a named error | 41 tests green |
| F8 | Added table cases for `isNumber`, `isInteger`, `isLength`, `isArrayLike` (including string-is-array-like and `NaN`-is-a-number), plus two `isPlainObject` non-object cases | 13 + 2 tests green; `guards.ts` mutation score 44.3 % -> 98.2 %, 2 equivalent survivors |
| F9 | A factory with no static model ids now generates an explicit test asserting it is discoverable, instead of silently skipping | 23 tests green; the OpenRouter case is now visible by name |
| F11 | Six positive substring assertions became `toContainEqual(expect.objectContaining({ text: expect.stringContaining(...) }))`; negatives keep scanning serialized content | 41 tests green |
| F12 | The bare-413 case asserts `"unknown"` instead of `not.toBe("context-overflow")` | green |
| F13 | Added `createSubmissionCapture()`; four duplicated capture blocks deleted | 19 tests green |
| F14 | One `try/catch` with `expect.unreachable()` replaces `toThrow` plus a second call | green |
| F6 | `FileObservationClock` (`now`, `delay`, `onInterval`) injected into `createDrizzleFileObservationStore` and exposed as `DrizzleSessionStoreOptions.clock`; prune grace, lease deadline, polling delay, and heartbeat all route through it | 3 new tests cover lease timeout, lease loss, and the 29 999 / 30 000 ms prune boundary; 5/5 in the file green |
| F7 | `RuntimeClock` (`now`, `sleep`) injected into `createAgentRuntime` as `clock`; every terminal/started timestamp and the retry backoff use it | retry test now asserts `retryAt === 1_700_000_000_025` and the 25 ms sleep exactly; 85/85 agent-core green |
| F10 | 132 tests wrapped in 15 domain `describe` blocks (plugin history/state, navigation, branch import/export, projection rebuild, attachment collection, writer authority, deletion/statistics) | 132/132 green; formatting-only re-indent, no assertion changed |

Verification after the fixes: `bun check` clean, `bun check-types` clean, six
full `bun run test` runs across both passes exit 0 (262 files, 2550 tests, 0
failures), and the gate baseline sits at 102 fixed waits in 37 files after F2/F3
removed 22.


Honest limits, so nobody reads this as full coverage:

- Six large files were scanned statistically (size, conditionals, sleeps, weak
  assertions) but not read line by line:
  `agent-session.test.ts` (5463), `session-host.test.ts` (5177),
  `session-sdk.test.ts` (3473), `chat-shell.test.tsx` (2990), `session-view.test.tsx`
  (2877), `modes.test.ts` (2373). They hold 22 353 lines between them; no
  findings are claimed for them.
- The 9 e2e files other than the tmux history test were not executed or read.
- Testability was assessed on three app modules (`agent-runtime`,
  `versioned-editing-store`, subagents coordinator) plus the two positive
  precedents. `packages/ai` was not assessed for testability.
- One hygiene observation, not chased to a root cause: a full default-portfolio
  run leaves `session-projection.sqlite` (plus `-wal`/`-shm`) in the caller's
  working directory. It is untracked, not in `.gitignore`, and was removed after
  the runs. Likely a test that falls back to the default database path; worth a
  targeted follow-up so runs do not dirty the tree.

## Next actions, in order

1. Decide on the mutation runner: add `@stryker-mutator/core` +
   `@hughescr/stryker-bun-runner` as devDependencies and run a nightly
   `mutate: ["packages/*/src/**"]` job, or keep the probe recipe here and re-run
   it per release. Needs an explicit dependency decision, so not done.
2. Investigate the `session-projection.sqlite` leak from a full portfolio run
   (see [Not reviewed](#not-reviewed)).
3. Drain the remaining 102 fixed waits the ratchet grandfathers, starting with
   the tmux harness (10) and the provider/terminal interaction suites.

Batch 2 ([test-quality-review-batch2.md](./test-quality-review-batch2.md))
follows up at HEAD `b957995a`: item 2 is fixed (`7fa32ba3`), item 3 is at 100
sites of which 10 were invisible to the ratchet, item 1 is still open.
