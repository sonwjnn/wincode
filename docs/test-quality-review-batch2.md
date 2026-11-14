# Test quality review, batch 2 — HEAD `b957995a`

Second pass over the same repository, run at HEAD after batch 1
([test-quality-review.md](./test-quality-review.md)) closed its fourteen
findings. Batch 1 reviewed 2026-11-14 at `4830acfb`; the only product and test
changes since were `7fa32ba3` (in-memory Session projection) and `b957995a`
(Default portfolio selected by tier), so this pass re-ran the full method
instead of a diff review: quantify, sample, run, mutate.

```
bun run test                 # 3 runs before fixes, 3 runs after, all exit 0
bun run check:test-smells    # the ratchet this pass wires into that command
bun check
bun check-types
```

## Evidence base

| Check | Before fixes | After fixes |
| --- | --- | --- |
| Suite green, 3 independent runs | 2568 tests, 263 Default files, 0 failures each run | 2573 tests, 263 Default files, 0 failures each run |
| `coding-agent` package wall time | 107.29 s / 107.3 s / 107.3 s | 80.46 s / 80.4 s / 80.5 s |
| Sum of per-test durations | 108.9 s | 82.0 s |
| Tests at or above 1 s / 100 ms | 16 / 164 | 12 / 170 |
| Slower than 5 s | 3 (two at 10.3 s, one at 5.0 s) | 0 |
| Fixed waits in the test tree | 102 sites / 37 test files (9 more in helpers, invisible to the gate) | 100 sites / 42 files, all ratcheted |
| Mutation probe | 8/11 killed (73 %) | 10/11 killed (91 %) |
| `bun check`, `bun check-types` | clean | clean |

Suite shape at HEAD: 263 Default files (208 `coding-agent`, 24 `ai`, 9 `mcp`,
9 `utils`, 7 `subagents`, 6 `agent-core`) holding 2552 Default tests, plus 16
script-contract tests, plus 9 e2e files. `scripts/test-tiers.json` classifies all
263 Default files (33 smoke, 138 core, 92 extended) against source `93522ba5`.

Sampling: 30 of 263 Default files (11 %) read at one of three depths — line by
line, test-and-assertion extraction for the files over 2000 lines, or targeted
reads of every flagged site. [Files reviewed](#files-reviewed) states which.

## Summary of findings

| ID | Severity | Smell | Location | Status |
| --- | --- | --- | --- | --- |
| F1 | High | The fixed-wait ratchet ran nowhere: not in `test`, not in CI, not in lefthook | `scripts/test-smell-check.ts`; `package.json` | Fixed |
| F2 | High | The ratchet scanned `*.test.*` only, so the helper that synchronizes 27 files was unchecked | `scripts/test-smell-check.ts`, `scripts/test-discovery.ts` | Fixed |
| F3 | High | `Promise.race` against `Bun.sleep(10_000)` left a live timer, so every RPC-mode process lingered 10 s after its last frame | `packages/mcp/src/registry.ts:714` | Fixed |
| F4 | High | A test polled for `"200K"` / `"300K"`, needles the frame can never contain, burning 4 s and hiding whether the context window refreshed | `packages/coding-agent/test/sessions/chat-shell.test.tsx:2147` | Fixed test; product question open |
| F5 | Medium | The renderer suite's synchronization contract is an unmeasured 20 ms constant with under 2x margin | `packages/coding-agent/test/support/opentui.ts:51` | Ratcheted; no deterministic replacement found |
| F6 | Medium | RPC shutdown deadline is a hard-coded `Date.now() + 5000` with no seam, so its test waited the real 5 s | `packages/coding-agent/modules/application/rpc/runner.ts:188` | Fixed |
| F7 | Medium | `isObjectLike` and `isPlainObject` had no test; both mutations survived | `packages/utils/test/scalar-predicates.test.ts` | Fixed |
| F8 | Medium | `await Bun.sleep(20)` inside `act(...)` immediately before `flushTestRenderer` — redundant in 2 files, 10 sites | `copy-on-select-component.test.tsx`, `provider-models-dialog.test.tsx` | Fixed |
| F9 | Low | Four independently written "settle the renderer" helpers with different rhythms | `test/support/opentui.ts`, `chat-shell`, `session-view`, `markdown-message-part` | Consolidated where behaviour held |
| F10 | Low | The `remaining === 0` shutdown-deadline branch had no test | `rpc.test.ts` | Fixed |
| F11 | Low | The gate's own report said "1 test files" | `test-smell-check.ts` | Fixed |
| F12 | Medium | `Bun.sleep(0)` as the only "async work has run" signal survives in 15 sites | see [Reliability](#reliability) | Open |
| F13 | Low | Slowest remaining tests: 7 preflight tests at ~1.5 s each, 3 provider-retry tests at ~2 s | `new-session-view-focus.test.tsx`, `session-sdk.test.ts` | Open |

## Gate and automation

The batch-1 report introduced `scripts/test-smell-check.ts` as the response to
the fixed-wait smell and recorded "the ratchet gate exit 0" as verification. Two
things were wrong with it, and they compound.

**F1: nothing ran it.** `grep -rn "test-smell-check"` over `.github/`,
`lefthook.yml`, and `package.json` returned nothing. CI runs `bun run test`
(`.github/workflows/ci.yml:67`), and `test` never called the gate, so the
baseline was a comment rather than a ratchet: a commit could add any number of
fixed waits and every lane stayed green. Fix: `check:test-smells` is now a root
script and `test` runs it between the script contracts and the portfolio, with a
`test-portfolio.test.ts` case pinning that ordering.
**F2: it could not see the wait that mattered.** `evaluateFixedWaits` iterated
`discoverTests(root)`, which matches `*.test.ts(x)`. The helpers under
`packages/*/test/support` and `test/fixtures` are not test files, so they were
invisible — including `flushTestRenderer`, whose 20 ms sleep gates every file
that renders (`grep -rl flushTestRenderer packages/coding-agent/test` → 27
files). Nine fixed waits lived in that blind spot. Fix:
`discoverTestSupportFiles()` in `test-discovery.ts` returns non-test
`.ts`/`.tsx` files under a package `test` tree, the ratchet scans both sets, and
the baseline now records 42 files / 100 sites (314 files scanned total). Two new
`test-smell-check.test.ts` cases fail the gate when a helper gains a wait, and
ignore helper files outside a package test tree.

Remaining limitation, unchanged by design: the ratchet compares per-file counts,
so removing one wait and adding another in the same file stays green. Line
identity would make the baseline churn on every edit; the count is the
enforceable part.

## Reliability

- **F5 (medium).** `flushTestRenderer` is `act(() => sleep(20) → renderOnce →
  waitForVisualIdle)`. That 20 ms is the synchronization contract for 27
  renderer files, and this pass measured its margin instead of trusting it:
  removing the sleep fails 28 tests (several by 30 s timeout); reducing it to
  10 ms fails on the first file it renders. So the suite is green with a
  constant that has less than 2x headroom, and every one of those 28 failures
  would surface as an unrelated assertion failure ("clipboard.writes was `[]`")
  rather than "the renderer was still busy". I did not find a deterministic
  replacement: `waitForVisualIdle` alone does not settle the commit the sleep
  covers. What the gate can do, and now does, is stop the constant from
  multiplying.
- **F8 (medium), fixed.** `copy-on-select-component.test.tsx` and
  `provider-models-dialog.test.tsx` waited 20 ms inside `act(...)` and then
  called `flushTestRenderer` — which waits another 20 ms and then renders. The
  first wait buys nothing the second does not. Ten sites removed, each file green
  3/3 afterwards. This is the same shape as batch 1's F2, which fixed one file
  and left its siblings; that is the argument for the ratchet, not for another
  sweep.
- **F12 (medium), open.** Fifteen `await Bun.sleep(0)` sites remain, and they are
  the batch-1 F3 pattern: the test asserts state that a public operation has not
  promised to have reached. `agent-session.test.ts:2597,3123,3947,3999`,
  `session-host.test.ts:1456`, `session-sdk.test.ts:3386`,
  `execution-registry.test.ts:27,68`, `maintenance-workflow.test.ts:595`,
  `plugin-provider-registration.test.ts:70`, `google-cached-content.test.ts:178`,
  `sdk-public.test.ts:299`. A tick is not a signal: adding one `await` inside the
  producer flips these tests. The fix is a completion promise on the public
  operation, per file, which is why it is listed rather than done.
  `session-failed-attempt.test.ts` (5 x `Bun.sleep(10)` before an assertion) and
  `session-sdk.test.ts` (3 x `Bun.sleep(10)`) are the same class with a different
  number.

## Diagnostic value

- **F4 (high), fixed as a test defect, open as a product question.**
  `chat-shell.test.tsx` "refreshes Provider Model usage metadata after model
  discovery changes" polled for `"200K"`, then `"300K"`. The footer renders its
  limit lowercased (`session-usage-bar.tsx:70`: `formatModelTokenCount(...).toLowerCase()`),
  so neither needle can ever appear. Instrumenting the helper showed 89 and 90
  poll iterations, 2.0 s each, `found=false` on both — the test spent 4.0 s
  waiting for a condition that was false by construction, then passed on
  `~$0.10` and on `not.toContain("200K")`, a negative assertion that cannot fail
  (batch 1's F12 shape).

  What the frame actually shows, before and after the availability bump:

  ```
  wincode:master   ↑100K ↓1  ~$0.10  ~0.0%/272k (auto)
  wincode:master   ↑100K ↓1  ~$1.00  ~0.0%/272k (auto)
  ```

  Pricing refreshes; the context window stays at
  `DEFAULT_CONTEXT_WINDOW_TOKENS` 272 000 although the discovered model declares
  300 000. So either the footer is meant to follow discovered model limits and
  does not, or the test name was wrong. I fixed the test to assert what it
  verifies (pricing, 4.07 s → 46.7 ms, needle reachable, vacuous assertion
  dropped) and left the window question open rather than encoding either answer.

- **F10 (low).** The deadline branch `if (remaining === 0)` had no test: a
  mutation to `< 0` survived the whole `rpc.test.ts` file. Added a zero-budget
  case (shutdown that never settles, budget 0, must log the overrun and finish).
  The mutant still survives, and now for a good reason: with `remaining = 0` the
  timer path logs the same warning one macrotask later, so the mutant is
  semantically equivalent. Recorded here so the next reader does not re-chase it.

## Testability

- **F6 (medium), fixed.** `runner.ts` computed `const deadline = Date.now() +
  5000` inline inside `cleanup`, so the only way to test "cleanup finishes at one
  bounded deadline" was to wait five seconds for a shutdown that never settles.
  `shutdownDeadlineMs` is now an `RpcRunnerOptions` field defaulting to 5000, the
  existing test passes 25 ms and asserts the same contract (exit 130, one
  shutdown call, no stderr, one "RPC shutdown deadline exceeded" record) in
  27 ms instead of 5004 ms. This is batch 1's F6/F7 class — wall-clock constants
  with no seam — in the HTTP-less half of the application.
- **F3 (high), fixed.** Not a test smell, found by reading the slow-test list:
  `packages/mcp/src/registry.ts` raced the MCP connection settle against
  `Bun.sleep(10_000)`. `Bun.sleep` hands back a promise, not a handle, so the
  timer stayed armed after the connections won. Every process that initializes
  the registry — every RPC session, every TUI session at exit — kept the event
  loop alive for the full ten seconds. Measured directly:

  ```
  before  0.31 s response, 10.32 s exit
  after   0.32 s response,  0.32 s exit
  ```

  The timer is now created with `setTimeout` and cleared in a `finally`, so the
  deadline bounds the wait without extending the lifetime. The two
  `executable.test.ts` RPC tests that cost 10.3 s each were a symptom, not a
  cause: 21.8 s → 1.77 s for the file. Any RPC client that shuts down was paying
  the same ten seconds.

## Design

- **F9 (low).** The suite has four ways to settle a renderer, written
  independently:
  `flushTestRenderer(setup, passes)` (support, sleep 20 + render + idle),
  `chat-shell`'s `flushUi` (sleep 20 + render), `session-view`'s `flushUi`
  (idle + frame-stability loop, 50 x 20 ms), and `markdown-message-part`'s
  `settleRenders` (3 x sleep 10 + render). Consolidation done where behaviour
  held: `flushTestRendererUntilStable` moved into `test/support/opentui.ts` and
  `session-view` now imports it (37 tests green), `markdown-message-part`'s local
  helper now delegates to `flushTestRenderer(setup, 3)` (13 green). `chat-shell`
  keeps its variant with a comment: routing it through the shared helper adds a
  `waitForVisualIdle` pass inside `act` and changes the focus state four of its
  tests assert on.

## Coverage

- **F7 (medium), fixed.** `packages/utils/src/guards.ts` exports 15 predicates;
  `scalar-predicates.test.ts` covered 13. Batch 1's F8 added the missing
  `isNumber`, `isInteger`, `isLength`, `isArrayLike` cases to this file and
  stopped there, leaving `isObjectLike` and `isPlainObject` with no assertion
  anywhere in the repository (grep finds only call sites inside other tests).
  Mutation confirmed both: flipping `value !== null` to `value === null`, and
  dropping `prototype === Object.prototype` from `isPlainObject`, left the file
  green. Two tests added (null/primitive/function boundaries; prototype-less
  object, class instance, array); both mutants are now killed.
- **F13 (low), open.** The eight slowest remaining `coding-agent` tests are seven
  `NewSessionView pinned Plugin Agent model preflight` cases at 1.44–1.62 s each
  (~10 s of the 80 s package wall) and three provider-retry tests at ~2 s. All
  are inside bounded waits rather than open-ended ones, so they are correctness-
  neutral; each preflight case looks like it pays a fixed 1.4 s settle. Not
  investigated for this pass.

## AI-generated smells

The repository is agent-authored and agent-reviewed, so the AI-specific checks
were run explicitly:

- Fabricated imports: none. `bun check-types` and three suite runs cover every
  import in the sample.
- Hallucinated needles: **one found** — F4's `"200K"` / `"300K"`, a locator that
  never matched and therefore never asserted.
- Closed loop: batch 1 fixed a file and its sibling kept the identical smell
  (F8), and added four predicates while two others in the same file stayed
  untested (F7). Both are the signature of tests written to describe the change
  in front of them rather than the module's boundary.
- Project conventions: no drift found in the sample; this suite names behavior
  and condition consistently, and the newest test
  (`session-database-path.test.ts`) is a good template — one contract per test,
  root cause in a comment.

## Fixes applied

| Finding | Change | Verification |
| --- | --- | --- |
| F1 | `check:test-smells` script; `test` runs it before the portfolio; `test-portfolio.test.ts` pins the ordering | gate exits 0; 18 script tests green |
| F2 | `discoverTestSupportFiles()`; ratchet scans tests and helpers; baseline rebuilt (42 files, 100 sites) | 2 new ratchet cases; 314 files scanned |
| F3 | MCP catalog deadline uses a cleared timer instead of `Bun.sleep(10_000)` | RPC exit 10.32 s → 0.32 s; 118 MCP tests green; `executable.test.ts` 21.8 s → 1.77 s |
| F4 | Test renamed to the pricing contract it verifies; needles are `~$0.10` / `~$1.00`; vacuous negative dropped | 61 chat-shell tests green; 4.07 s → 46.7 ms |
| F5 | Renderer helper waits are now inside the ratchet's scope | baseline records `test/support/opentui.ts: 3` |
| F6 | `RpcRunnerOptions.shutdownDeadlineMs`, default 5000 | 25 RPC tests green; 5004 ms → 27 ms |
| F7 | `isObjectLike` / `isPlainObject` contract tests | 15 predicate tests green; both mutants killed |
| F8 | 10 redundant sleeps deleted from 2 files | each file 3/3 runs green |
| F9 | Shared `flushTestRendererUntilStable`; `session-view` and `markdown-message-part` delegate | 37 + 13 tests green |
| F10 | Zero-budget deadline test | 25 RPC tests green |
| F11 | Report grammar: "N test-tree file(s) gained a fixed wait" | ratchet test asserts the message |

## Files reviewed

| File | Severity | Depth | Finding |
| --- | --- | --- | --- |
| `scripts/test-smell-check.ts` | High | full | F1, F2, F11 |
| `scripts/test-smell-check.test.ts` | — | full | gate cases added |
| `scripts/test-discovery.ts` | High | full | F2 |
| `scripts/test-portfolio.ts` | — | partial (runner, tiers) | none — tier manifest validates both directions |
| `scripts/test-portfolio.test.ts` | — | partial (first 140 lines + case list) | none |
| `package.json` | High | full | F1 |
| `packages/coding-agent/test/support/opentui.ts` | Medium | full | F5, F9 |
| `packages/coding-agent/test/copy-on-select-component.test.tsx` | Medium | full | F8 |
| `packages/coding-agent/test/providers/provider-models-dialog.test.tsx` | Medium | flagged sites | F8 |
| `packages/coding-agent/test/sessions/chat-shell.test.tsx` | High | partial + instrumented | F4, F9 |
| `packages/coding-agent/test/sessions/session-view.test.tsx` | Low | partial | F9 |
| `packages/coding-agent/test/sessions/markdown-message-part.test.tsx` | Low | partial | F9 |
| `packages/coding-agent/test/sessions/new-session-view-focus.test.tsx` | Low | flagged sites | F5 context, F13 |
| `packages/coding-agent/test/sessions/session-failed-attempt.test.ts` | Medium | flagged sites | F12 |
| `packages/coding-agent/test/sessions/session-sdk.test.ts` | Medium | structured scan (39 tests) | F12, F13 |
| `packages/coding-agent/test/sessions/session-host.test.ts` | Medium | structured scan (65 tests) | F12 |
| `packages/coding-agent/test/sessions/agent-session.test.ts` | Medium | structured scan (95 tests) | F12 |
| `packages/coding-agent/test/sessions/session-jsonl-sdk.test.ts` | — | structured scan (131 tests) | waits are race guards or polling loops |
| `packages/coding-agent/test/sessions/session-jsonl-steering.test.ts` | — | flags | none — `Promise.race` guards |
| `packages/coding-agent/test/sessions/session-fork.test.ts` | — | flags | none — race guard + one 30 ms settle |
| `packages/coding-agent/test/sessions/session-database-path.test.ts` | — | full | none — good precedent |
| `packages/coding-agent/test/rpc.test.ts` | Medium | partial + fixes | F6, F10 |
| `packages/coding-agent/test/rpc-journey.test.ts` | — | flags | none — `Promise.race` guards |
| `packages/coding-agent/test/executable.test.ts` | High | full | F3 evidence |
| `packages/coding-agent/modules/application/rpc/runner.ts` | Medium | shutdown path | F6 |
| `packages/coding-agent/modules/application/rpc/types.ts` | Medium | options | F6 |
| `packages/mcp/src/registry.ts` | High | init path | F3 |
| `packages/mcp/test/config-resolve.test.ts` | — | flags | none — presence assertions are the contract |
| `packages/utils/test/scalar-predicates.test.ts` | Medium | full | F7 |
| `packages/utils/test/objects.test.ts` | — | flags | none — immutability assertions |
| `packages/subagents/test/task-runtime.test.ts` | — | structured scan | none — batch-1 F3 holds |
| `packages/ai/test/models-dev.test.ts` | — | flags | none |
| `packages/ai/test/sdk-public.test.ts` | — | flags | none — `Promise.race` guards |

## Not reviewed

- 233 Default files were quantified (size, asserts per test, fixed waits,
  conditionals, network, mocks) but not read:
  `agent-session.test.ts`, `session-host.test.ts`, `session-jsonl-sdk.test.ts`,
  `session-sdk.test.ts`, `chat-shell.test.tsx`, `session-view.test.tsx`,
  `compaction.test.ts`, `modes.test.ts`, `rpc-journey.test.ts` received
  test-and-assertion extraction only, which finds structure but not wrong logic
  inside a passing assertion.
- The 9 e2e files were not executed; `test:e2e` was out of scope for this pass.
- `packages/ai` was sampled (3 files) but not assessed for testability.
- No Stryker run: the probe is a hand-rolled 11-mutant sample over three modules,
  not a suite-wide score. A suite-wide number needs the dependency decision batch
  1 left open.

## Next actions, in order

1. Decide the F4 product question: should the usage bar follow discovered model
   `limits.contextWindowTokens`, or is `DEFAULT_CONTEXT_WINDOW_TOKENS` the
   intended fixed window? If it should follow, the footer is a defect the old
   test hid; if not, the batch-1 test name was the only defect.
2. Replace the 15 `Bun.sleep(0)` sites (F12) with completion promises on the
   public operations, starting with `execution-registry.test.ts` (2 sites, one
   operation each).
3. Investigate the 1.4 s settle in the seven `NewSessionView … preflight` tests
   (F13) — ~10 s of the 80 s package wall in one cluster.
4. Add the mutation runner as a devDependency and run it nightly, so "the test
   asserts something" is measured rather than argued (batch-1 action 1, still
   open).
