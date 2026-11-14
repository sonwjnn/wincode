# Test curation log

Status: **audit only**. No test was deleted, skipped, moved or retagged by this run.
Approver: pending. Observation window once anything is quarantined: **2 releases**.

Scope: every Default-portfolio test in the monorepo (262 files, 2542 test cases).
Reproduce with the harness in `scripts/test-curation/` (run order in its README); artifacts stay under `.tmp/test-curation/`.

## 1. What this audit measured, and what it could not

| Input | How | Result |
|---|---|---|
| Per-test outcomes | `bun test --reporter=junit` per package, 3 independent runs on one commit | 2542 tests, 36,193 assertions, 109 s wall clock |
| Per-test covered lines | each test run alone (`-t <name>`) with `--coverage --coverage-reporter=lcov` | 77,674 distinct application lines |
| Near-duplicate clustering | normalized token 5-gram shingles, MinHash LSH, Jaccard >= 0.85 structural **and** >= 0.7 literal-preserving, >= 20 tokens | 39 clusters / 82 tests |
| Defect kill-sets | 47 operator mutants on covered lines + 30 reverse-applied historical fixes, inside a detached git worktree | 19 + 12 defects detected |
| Defect history | 1,096 commits, 295 `fix:` commits, 471 test cases added by fixes | 181 test files involved in a fix |
| CI history | `gh run list` (job level only) | no per-test history available |

Three constraints bound every conclusion below:

1. **No true per-test coverage contexts.** Bun 1.4 has no `--cov-context` equivalent. Per-test fingerprints come from running each test alone, which discards cross-test state and cannot observe tests that only fail in file context. 7 tests have duplicate names and matched more than one case; their fingerprints are unions and are marked ambiguous below.
2. **Line coverage only, no branches.** Bun's lcov reporter emits no `BRDA` records: 0 branch records across the shard reports. Every `coverage_delta` in this log is lines only.
3. **Coverage is dominated by module loading.** 69,940 of 77,674 application lines (90.0%) are covered by two or more tests, and 131 groups of tests have **identical** covered-line sets. In this stack, coverage equality is a property of the import graph, not of the assertion. Section 4 shows what that does to a naive prune.

## 2. Corpus

| Metric | Value |
|---|---|
| Default test files | 262 |
| Test cases | 2542 |
| Assertions | 36,193 |
| Wall clock (sum of per-file durations) | 109 s |
| Slowest file | `executable.test.ts` 21.8 s, then `new-session-view-focus.test.tsx` 14.6 s, `session-view.test.tsx` 11.7 s (top 3 = 48 s, 44% of the suite) |
| Portfolios today | `default` and `e2e`, split by `scripts/test-discovery.ts`; no tier markers |

## 3. Coverage fingerprints

- 77,674 distinct application lines covered.
- 7,734 lines are covered by **exactly one** test (`10.0%`). Losing the owning test loses that coverage outright.
- 69,940 lines are covered by two or more tests.
- 49 tests cover **zero** application lines: they exercise subprocesses, spawn the built binary, or assert on generated data. They are invisible to coverage-based pruning and are protected by construction.
- 64 of the 82 clustered tests own no line that another test does not also cover, and 49 tests cover no application line at all. Both groups are invisible to coverage-based justification and are protected by construction.

Files with the most singly-owned lines (deleting their sole owner loses the line):

| Source file | Lines owned by exactly one test |
|---|---|
| `packages/coding-agent/modules/sessions/storage/session-jsonl-store.ts` | 785 |
| `packages/coding-agent/modules/application/sessions-cli.ts` | 324 |
| `packages/coding-agent/modules/application/rpc/request-handler.ts` | 258 |
| `packages/mcp/src/registry.ts` | 235 |
| `packages/coding-agent/modules/tools/shell/runner.ts` | 168 |
| `packages/coding-agent/modules/sessions/ui/views/session-view.tsx` | 158 |
| `packages/ai/src/sdk-private/openai-oauth.ts` | 124 |
| `packages/coding-agent/modules/providers/ui/provider-sdk-connect-dialog.tsx` | 119 |
| `packages/utils/src/logger.ts` | 118 |
| `packages/coding-agent/modules/sessions/storage/drizzle-session-store.ts` | 118 |

## 4. The coverage-equality trap, measured on this repo

131 groups of tests have byte-identical covered-line sets (group sizes up to 11). A coverage-only prune would pick a survivor in each group and delete the rest. Review of every group containing a near-duplicate cluster produced this verdict table:

| Cluster | Tests | Identical coverage | Verdict | Why |
|---|---|---|---|---|
| 0 | 4 | 2/6 pairs | keep | Four distinct thinking-level fallback policies: lower-level reset, higher-first fallback, closest-lower fallback, Off only when sole. Same resolver, different rules. |
| 1 | 3 | 3/3 pairs | keep | Three distinct plugin-registration rejections: undeclared policy category, family/category mismatch, missing context projection. |
| 7 | 2 | 1/1 pairs | keep | Two different concurrency invariants: single in-flight compaction per session vs joining an in-flight maintenance compaction across a selection change. |
| 10 | 2 | 1/1 pairs | keep | Manual-mode copy vs range copy without clearing: different mode flag and different post-state. |
| 17 | 2 | 1/1 pairs | keep | Plugin summary persistence/validation vs generator must not be invoked: different oracles on the same path. |
| 23 | 2 | 1/1 pairs | keep | Two model-specific protocol routing rules (avoid Chat Completions vs selectable via Responses). |
| 24 | 2 | 1/1 pairs | keep | Two separate subprocess CLI behaviors: static load order vs help availability before runtime init. |
| 25 | 2 | 1/1 pairs | keep | Two distinct clipboard statuses (empty vs unsupported) mapping to the same no-content result. |
| 27 | 2 | 1/1 pairs | keep | Markdown/syntax token keys vs diff token keys: disjoint key sets. |
| 28 | 2 | 1/1 pairs | keep | OpenCode markdown override entries vs diff override entries: disjoint override maps. |
| 30 | 2 | 1/1 pairs | keep | Two distinct compaction guards: history already inside the recent budget vs all complete history inside it. |
| 33 | 2 | 1/1 pairs | keep | Complete skill metadata vs activation metadata without instructions: the second asserts absence, which the first does not. |

**Result: all 12 identical-coverage clusters are distinct oracles that happen to share a code path; 8 of their pairs are proven distinct by asymmetric kill-sets. No merge candidate remains: the pair the previous audit found (`summary-generator.test.ts` output-limit vs filtered) is now one table-driven test.** The sharpest case is not in a cluster at all — it is a 99%-identical coverage pair in `packages/utils/test/scalar-predicates.test.ts`:

- line 21 `accepts non-empty strings without trimming` asserts `isNonEmptyString("") === false`
- line 35 `accepts strings including empty strings` asserts `isString("") === true`

Different function, opposite assertion on the empty string, coverage Jaccard 0.99. Deleting either one silently removes the only guard on that distinction. This is the failure mode the coverage-equal prune creates, reproduced on demand.

## 5. Near-duplicate clusters

Clustering used a threshold of 0.85 with `token stream: literals-><lit>, identifier refs-><id>, property names and keywords kept`. 39 clusters contain 82 tests; the largest has 4 members; 1 cluster spans files. No whole-file copies exist (no two test files have the same sha256).

Every cluster is a **review candidate**, never a deletion:

| Cluster | Tests | Files | Min pair score | Identical coverage pairs | Member files |
|---|---|---|---|---|---|
| 0 | 4 | 1 | 0.87 | 2 | prompt-config-provider.test.ts |
| 1 | 3 | 1 | 0.87 | 3 | plugin-registry.test.ts |
| 2 | 3 | 1 | 0.92 | 0 | prompt-cache-warming.test.ts |
| 3 | 2 | 1 | 0.86 | 0 | chat-shell.test.tsx |
| 4 | 2 | 1 | 0.86 | 0 | file-operations.test.ts |
| 5 | 2 | 1 | 0.87 | 0 | project-trust-preflight.test.tsx |
| 6 | 2 | 1 | 0.87 | 0 | session-view.test.tsx |
| 7 | 2 | 1 | 0.87 | 1 | compaction.test.ts |
| 8 | 2 | 2 | 0.88 | 0 | sdk-consumer-bun.test.ts, sdk-consumer-node.test.ts |
| 9 | 2 | 1 | 0.89 | 0 | session-bundle-export.test.ts |
| 10 | 2 | 1 | 0.89 | 1 | clipboard-selection-interactions.test.tsx |
| 11 | 2 | 1 | 0.90 | 0 | logger.test.ts |
| 12 | 2 | 1 | 0.90 | 0 | clipboard-copy-on-select.test.ts |
| 13 | 2 | 1 | 0.91 | 0 | clipboard-selection-keys.test.ts |
| 14 | 2 | 1 | 0.91 | 0 | clipboard-selection-keys.test.ts |
| 15 | 2 | 1 | 0.91 | 0 | scalar-predicates.test.ts |
| 16 | 2 | 1 | 0.92 | 0 | submit.test.ts |
| 17 | 2 | 1 | 0.95 | 1 | compaction.test.ts |
| 18 | 2 | 1 | 0.95 | 0 | new-session-view-focus.test.tsx |
| 19 | 2 | 1 | 0.98 | 0 | rpc.test.ts |
| 20 | 2 | 1 | 0.98 | 0 | attachment-store.test.ts |
| 21 | 2 | 1 | 0.99 | 0 | rpc-output.test.ts |
| 22 | 2 | 1 | 1.00 | 0 | agent-session.test.ts |
| 23 | 2 | 1 | 1.00 | 1 | sdk-opencode-go-provider.test.ts |
| 24 | 2 | 1 | 1.00 | 1 | cli-startup.test.ts |
| 25 | 2 | 1 | 1.00 | 1 | clipboard.test.ts |
| 26 | 2 | 1 | 1.00 | 0 | registry.test.ts |
| 27 | 2 | 1 | 1.00 | 1 | provider-themes.test.ts |
| 28 | 2 | 1 | 1.00 | 1 | provider-themes.test.ts |
| 29 | 2 | 1 | 1.00 | 0 | chat-shell.test.tsx |
| 30 | 2 | 1 | 1.00 | 1 | compaction.test.ts |
| 31 | 2 | 1 | 1.00 | 0 | markdown-message-part.test.tsx |
| 32 | 2 | 1 | 1.00 | 0 | new-session-view-focus.test.tsx |
| 33 | 2 | 1 | 1.00 | 1 | user-message.test.ts |
| 34 | 2 | 1 | 1.00 | 0 | settings-dialog.test.tsx |
| 35 | 2 | 1 | 1.00 | 0 | tools-versioned-editing.test.ts |
| 36 | 2 | 1 | 1.00 | 0 | use-git-branch.test.tsx |
| 37 | 2 | 1 | 1.00 | 0 | client.test.ts |
| 38 | 2 | 1 | 1.00 | 0 | scalar-predicates.test.ts |

## 6. Defect evidence (kill sets)

Bun has no mutation-testing runner here, so subsumption was tested two ways. Both run inside a detached git worktree; the live tree was never mutated.

**A. Operator mutants on covered lines.** 47 mutants across 6 clusters (comparisons and boolean operators swapped on lines the cluster members already execute). 19 were killed, and 7 of those killed by some members while a peer survived the same mutation. Clusters whose subject module yielded no usable operators (barrel `index.ts`, schema-only modules) contributed no evidence and are marked 0.

**B. Historical defect reintroduction.** 30 reverse-applied `fix:` commits across 16 clusters, each scoped to the cluster's subject module. 12 reverts were detected by the tests; in every detected case **every member of the cluster failed** (2/2 or 3/3). 0 asymmetric kills. This arm is weaker than the mutant arm: a reverted fix can touch shared code, and for three clusters the resolved subject module was a barrel `index.ts`, so a revert there breaks more than the behavior under test. A kill here confirms the test can fail; it does not isolate which rule it guards.

| Cluster | Test file | Reverts attempted | Reverts detected by every member | Operator mutants | Mutants killed |
|---|---|---|---|---|---|
| 0 | `prompt-config-provider.test.ts` | 0 | 0 | 7 | 6 |
| 1 | `plugin-registry.test.ts` | 0 | 0 | 8 | 5 |
| 3 | `chat-shell.test.tsx` | 2 | 1 | 0 | 0 |
| 5 | `project-trust-preflight.test.tsx` | 3 | 1 | 0 | 0 |
| 6 | `session-view.test.tsx` | 4 | 1 | 0 | 0 |
| 7 | `compaction.test.ts` | 1 | 0 | 8 | 1 |
| 15 | `scalar-predicates.test.ts` | 1 | 1 | 0 | 0 |
| 16 | `submit.test.ts` | 1 | 0 | 0 | 0 |
| 17 | `compaction.test.ts` | 1 | 0 | 8 | 0 |
| 18 | `new-session-view-focus.test.tsx` | 4 | 2 | 0 | 0 |
| 22 | `agent-session.test.ts` | 1 | 1 | 0 | 0 |
| 23 | `sdk-opencode-go-provider.test.ts` | 0 | 0 | 8 | 4 |
| 24 | `cli-startup.test.ts` | 0 | 0 | 0 | 0 |
| 25 | `clipboard.test.ts` | 1 | 0 | 0 | 0 |
| 29 | `chat-shell.test.tsx` | 2 | 1 | 0 | 0 |
| 30 | `compaction.test.ts` | 1 | 0 | 8 | 3 |
| 32 | `new-session-view-focus.test.tsx` | 4 | 2 | 0 | 0 |
| 34 | `settings-dialog.test.tsx` | 1 | 0 | 0 | 0 |
| 36 | `use-git-branch.test.tsx` | 2 | 1 | 0 | 0 |
| 38 | `scalar-predicates.test.ts` | 1 | 1 | 0 | 0 |

Interpretation. The operator mutants produced the decisive evidence: **8 cluster pairs have asymmetric kills** (one member fails, a peer passes), all in clusters 0 and 1, so those tests demonstrably do not subsume each other even though their covered-line sets are identical. Cluster 0's asymmetric mutants sit exactly on the thinking-level fallback rules (L469, L473, L475 of `provider-model-selection.ts`), which is what the code review predicted. Cluster 1's sit on separate plugin-rejection validations.

## 7. CI history and flakiness

**Archived history.** CI uploads no per-test results: the only artifact is `test-artifacts/e2e` on E2E failure. Job-level history is available (`gh run list`), e.g. 7 failed runs on one PR branch (`feat/session-history-tree`) and a green `master`. Job-level pass/fail is not per-test evidence, so it is not used for any disposition here.

**Same-SHA divergence.** Flakiness is defined as the same commit producing both a pass and a fail. 3 full portfolio runs on one commit: 2542 tests each, **0 divergences, 0 missing**. One divergence was observed outside the portfolio lane:

- `packages/coding-agent/test/sessions/session-host.test.ts` — `SDK Host shutdown cleans its in-flight Google cache without affecting another Host` failed once while 6 coverage shards ran concurrently, then passed in 1 isolated run, 3 portfolio runs, 10 sequential file reruns and 12 concurrent reruns (1 failure in 23 observations of that file).
- The failing assertion showed the second Host's `created` cache list as `["cachedContents/second-host", "cachedContents/second-host"]` where one entry was expected.
- **Root cause confirmed.** This was not a race in the cache manager. The test built capabilities with the default workspace (`process.cwd()`, the repository root), and the composed system prompt embedded a volatile block with the live Git branch and status. Because the test deliberately holds the first turn across a second send, any working-tree change in that window changed the second Host's system prompt, which correctly changed the CachedContent identity: the manager deleted the now-invalid resource and created a new one. The trace showed the same session, key, tools and TTL with a different system-prompt hash (`3ad57507` -> `6b46c942`) before the second creation.
- Reproduced deterministically by creating and removing an untracked file in the repository every 60 ms: 2 of 6 runs failed at the same assertion. The fix moved the volatile environment block out of the cacheable system instructions into turn-scoped `<untrusted-environment-context>` input; the same churn harness then passed 6 of 6 runs, with the test running against the repository workspace again.
- Disposition: **test fixed at the root, not quarantined, not deleted.** The manager behaves correctly, and a working-tree change no longer invalidates an explicit Google CachedContent resource.

## 8. Obsolete tests

Import resolution over all 262 test files found 4 files with unresolved relative imports. All were read and are false positives: virtual module ids used with `mock.module`, plugin fixture paths written into temporary workspaces, and an `import()` inside a template string executed in a subprocess. No workspace package import (`@wincode/*`) fails to resolve.

**Obsolete disposition: empty.** Nothing in the Default portfolio tests a module that no longer exists. The historical test files for removed packages (`packages/tui`, `packages/runtime-utils`) are already gone.

## 9. Dispositions

Categories follow the skill's four states, each with its own action.

| Category | Count | Action |
|---|---|---|
| keep — proven distinct by asymmetric kill-set (clusters 0, 1) | 7 | keep; a defect exists that one member catches and a peer misses |
| keep — distinct oracle despite coverage equality (reviewed) | 20 | keep; protected from any coverage-based prune |
| merge-candidate — identical setup and oracle, parameter-only difference | 0 | optionally fold into one table-driven test (no assertion is lost) |
| review-candidate — near-duplicate without kill-set confirmation | 55 | stays a quarantine candidate; `mutation_check: partial` |
| obsolete | 0 | nothing to delete |
| low-value | 0 | no test was found that both never failed and asserts nothing; the 49 zero-coverage tests spawn real subprocesses |
| blackbox — no measurable application coverage | 49 | protected: coverage cannot see them, so coverage cannot justify removing them |
| ambiguous name — pattern matched several cases | 7 | excluded from per-test conclusions; file-level data still applies |

**Deletions proposed: 0. Quarantines applied: 0** (this run is report-only; nothing in the repository was changed).

## 10. Tiering proposal

Tiers are assigned from business risk and defect-detection history, with runtime only as a tiebreak:

- risk: domain in {sessions, providers, tools, application} or the provider SDK / RPC surface, per `ARCHITECTURE.md` (Session Host durable writes, provider credentials, tool execution, project trust).
- defect history: `3 x (fix commits touching the file) + 2 x (test cases added by fix commits)`.
- runtime tiebreak: `smoke` requires <= 5 s per file.

| Tier | Files | Tests | Wall clock |
|---|---|---|---|
| smoke | 32 | 645 | 8 s |
| core | 135 | 1326 | 97 s |
| extended | 95 | 571 | 5 s |

Smoke cohort (highest risk x proven defect history, each <= 5 s):

| Test file | Fixes | Tests added by fixes | Runtime |
|---|---|---|---|
| `packages/coding-agent/test/sessions/session-host.test.ts` | 16 | 33 | 1.7 s |
| `packages/coding-agent/test/sessions/agent-session.test.ts` | 9 | 24 | 0.0 s |
| `packages/coding-agent/test/sessions/compaction.test.ts` | 8 | 25 | 0.0 s |
| `packages/coding-agent/test/sessions/compaction-routing.test.ts` | 6 | 15 | 0.0 s |
| `packages/ai/test/sdk-public.test.ts` | 8 | 7 | 0.0 s |
| `packages/coding-agent/test/sessions/runtime-turn.test.ts` | 7 | 6 | 0.1 s |
| `packages/coding-agent/test/sessions/summary-generator.test.ts` | 4 | 9 | 0.0 s |
| `packages/coding-agent/test/application/project-trust.test.ts` | 4 | 7 | 0.1 s |
| `packages/coding-agent/test/rpc-projection.test.ts` | 3 | 8 | 0.1 s |
| `packages/ai/test/model-contracts.test.ts` | 4 | 6 | 0.0 s |
| `packages/coding-agent/test/sessions/session-context-edits.test.ts` | 1 | 9 | 0.9 s |
| `packages/ai/test/sdk-openai-compatible-providers.test.ts` | 3 | 5 | 0.0 s |
| `packages/coding-agent/test/sessions/session-writer-lock.test.ts` | 4 | 3 | 0.7 s |
| `packages/coding-agent/test/sessions/session-sdk.test.ts` | 5 | 1 | 1.4 s |
| `packages/coding-agent/test/providers/provider-stores.test.ts` | 2 | 5 | 0.0 s |
| `packages/ai/test/sdk-openai-provider.test.ts` | 3 | 3 | 0.0 s |
| `packages/coding-agent/test/application/plugins.test.ts` | 3 | 3 | 0.6 s |
| `packages/coding-agent/test/sessions/reset-session-data.test.ts` | 2 | 4 | 0.1 s |
| `packages/coding-agent/test/sessions/selections.test.ts` | 2 | 4 | 0.0 s |
| `packages/coding-agent/test/sessions/session-usage.test.ts` | 2 | 4 | 0.0 s |

Markers were **not** applied (report-only run). The suite is already 109 s, so a smoke tier buys little latency today; its value is the protected cohort, not the clock. If markers are adopted later, encode them as `test` tags and verify with the runner's list mode before removing anything from the default lane.

## 11. Audit record

One row per flagged test. Since nothing was quarantined or deleted, `approver` and `restore` record that state. `coverage_delta` is the number of application lines no other test covers (0 for exact-equality pairs, which by definition lose nothing). `mutation_check` records the kill-set evidence from section 6.

| Test | Category | Evidence | Superseded by | Coverage delta | Mutation check | Action | Approver | Restore |
|---|---|---|---|---|---|---|---|---|
| `prompt-config-provider.test.ts:40` resets to low when the newly selected Provider Model supports it | keep | Four distinct thinking-level fallback policies: lower-level reset, higher-first  | none — no survivor subsumes it | 0 lines / 0 branches | yes: 3 asymmetric mutant(s), cluster 0 | keep; no action | pending (no change applied) | n/a |
| `prompt-config-provider.test.ts:56` uses a higher-first fallback when the new model does not support low | keep | Four distinct thinking-level fallback policies: lower-level reset, higher-first  | none — no survivor subsumes it | 0 lines / 0 branches | yes: 3 asymmetric mutant(s), cluster 0 | keep; no action | pending (no change applied) | n/a |
| `prompt-config-provider.test.ts:72` falls back to the closest lower supported level when no higher level exists | keep | Four distinct thinking-level fallback policies: lower-level reset, higher-first  | none — no survivor subsumes it | 0 lines / 0 branches | yes: 3 asymmetric mutant(s), cluster 0 | keep; no action | pending (no change applied) | n/a |
| `prompt-config-provider.test.ts:88` uses explicit Off only when it is the sole supported fallback | keep | Four distinct thinking-level fallback policies: lower-level reset, higher-first  | none — no survivor subsumes it | 0 lines / 0 branches | yes: 3 asymmetric mutant(s), cluster 0 | keep; no action | pending (no change applied) | n/a |
| `plugin-registry.test.ts:159` an undeclared policy category is rejected during plugin registration | keep | Three distinct plugin-registration rejections: undeclared policy category, famil | none — no survivor subsumes it | 0 lines / 0 branches | yes: 4 asymmetric mutant(s), cluster 1 | keep; no action | pending (no change applied) | n/a |
| `plugin-registry.test.ts:191` a family adapter must match its declared policy category | keep | Three distinct plugin-registration rejections: undeclared policy category, famil | none — no survivor subsumes it | 0 lines / 0 branches | yes: 4 asymmetric mutant(s), cluster 1 | keep; no action | pending (no change applied) | n/a |
| `plugin-registry.test.ts:209` providers without a context projection are rejected before resolution | keep | Three distinct plugin-registration rejections: undeclared policy category, famil | none — no survivor subsumes it | 0 lines / 0 branches | yes: 4 asymmetric mutant(s), cluster 1 | keep; no action | pending (no change applied) | n/a |
| `prompt-cache-warming.test.ts:593` SDK warming skips Provider Models missing exact cache tiers or TTL metadata | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `prompt-cache-warming.test.ts:636` SDK warming skips Provider Models with no TTL for an advertised cache tier | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `prompt-cache-warming.test.ts:678` SDK warming skips a Provider Model whose exact price metadata is unknown | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `chat-shell.test.tsx:987` preserves another focused control when the pointer moves inside the view | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `chat-shell.test.tsx:1281` preserves another focused control when terminal focus returns | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `file-operations.test.ts:53` a completed Edit reports every file it committed | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `file-operations.test.ts:79` a batch Edit reports each file once even when a path repeats | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `project-trust-preflight.test.tsx:212` trust selector resolves Escape as cancellation instead of rejecting | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `project-trust-preflight.test.tsx:290` trust selector treats Ctrl+C as cancellation | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 7 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `session-view.test.tsx:677` manual compaction refuses an imported Session before Provider availability | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 5 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `session-view.test.tsx:718` manual compaction rejects a stale Host Plugin snapshot before Provider availability | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 6 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `compaction.test.ts:1638` only one compaction operation runs per session | keep | Two different concurrency invariants: single in-flight compaction per session vs | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `compaction.test.ts:1666` joins an in-flight maintenance compaction across a selection change | keep | Two different concurrency invariants: single in-flight compaction per session vs | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `sdk-consumer-bun.test.ts:94` Bun consumers preserve chat controls and terminal outcomes through the public SDK | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `sdk-consumer-node.test.ts:124` Node consumers import the public SDK | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `session-bundle-export.test.ts:1154` bundle manifest validation rejects a log ID ending in a line terminator | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `session-bundle-export.test.ts:1173` bundle manifest validation rejects path traversal before reading outside the bundle | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-selection-interactions.test.tsx:139` the copy shortcut copies a selection in manual mode | keep | Manual-mode copy vs range copy without clearing: different mode flag and differe | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-selection-interactions.test.tsx:155` the copy shortcut copies a selected range without clearing it | keep | Manual-mode copy vs range copy without clearing: different mode flag and differe | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `logger.test.ts:274` retries retention after the log directory becomes readable | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `logger.test.ts:291` retries retention when deleting an expired log fails | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 2 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-copy-on-select.test.ts:154` reports a rejected write without claiming the selection was copied | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-copy-on-select.test.ts:169` reports an oversized selection with the size-specific message | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-selection-keys.test.ts:61` the copy shortcut copies a selection and keeps it visible | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-selection-keys.test.ts:96` the copy shortcut absorbs an empty selection without clearing it | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-selection-keys.test.ts:78` the copy shortcut copies a double-click word selection | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard-selection-keys.test.ts:113` the copy shortcut absorbs a plain cell click without copying it | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `scalar-predicates.test.ts:69` accepts only positive integers | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `scalar-predicates.test.ts:78` accepts only positive safe integers | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `submit.test.ts:305` expands pasted-text markers before matching a selected marker | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `submit.test.ts:511` maps a selected marker through pasted-text expansion | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `compaction.test.ts:2883` a Plugin custom summary still passes host validation and persistence | keep | Plugin summary persistence/validation vs generator must not be invoked: differen | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `compaction.test.ts:3050` a Plugin summary avoids invoking a summary generator | keep | Plugin summary persistence/validation vs generator must not be invoked: differen | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `new-session-view-focus.test.tsx:1293` initializes the available low thinking level before creating a new reasoning Session | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `new-session-view-focus.test.tsx:1419` shows an Agent-pinned ThinkingLevel on a fresh session without changing submission selection | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `rpc.test.ts:818` RPC bundle export preserves source corruption sequence and byte offset | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `rpc.test.ts:894` RPC bundle export preserves unsupported-version sequence and byte offset | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 3 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `attachment-store.test.ts:807` releases the final queued attachment pin before collection | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `attachment-store.test.ts:833` holds a blob retained twice until both holds are released | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `rpc-output.test.ts:22` serialized writer replaces only an unsent state tail | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 5 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `rpc-output.test.ts:45` serialized writer keeps a state on each side of a response | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `agent-session.test.ts:1812` continue retains completed Tool Calls as context without rerunning them | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `agent-session.test.ts:1878` continue resumes retained denied Tool Calls without rerunning them | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `sdk-opencode-go-provider.test.ts:252` grok-4.6 avoids OpenCode Go's rejecting Chat Completions protocol | keep | Two model-specific protocol routing rules (avoid Chat Completions vs selectable  | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `sdk-opencode-go-provider.test.ts:295` gpt-6-luna is selectable through OpenCode Go's Responses route | keep | Two model-specific protocol routing rules (avoid Chat Completions vs selectable  | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `cli-startup.test.ts:87` interactive entrypoint statically loads before runtime context is initialized | keep | Two separate subprocess CLI behaviors: static load order vs help availability be | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `cli-startup.test.ts:110` CLI help remains available before an interactive runtime is initialized | keep | Two separate subprocess CLI behaviors: static load order vs help availability be | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard.test.ts:67` returns no content when the clipboard has no accepted image type | keep | Two distinct clipboard statuses (empty vs unsupported) mapping to the same no-co | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `clipboard.test.ts:75` returns no content when the platform cannot read images | keep | Two distinct clipboard statuses (empty vs unsupported) mapping to the same no-co | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `registry.test.ts:369` fails when a remote tools filter requests a missing tool | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `registry.test.ts:392` connects when a remote tools filter matches the exposed catalog | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `provider-themes.test.ts:274` resolves every bundled theme with complete markdown and syntax tokens | keep | Markdown/syntax token keys vs diff token keys: disjoint key sets. | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `provider-themes.test.ts:311` resolves every bundled theme with complete diff tokens | keep | Markdown/syntax token keys vs diff token keys: disjoint key sets. | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `provider-themes.test.ts:282` every bundled theme has a complete opencode-sourced override entry | keep | OpenCode markdown override entries vs diff override entries: disjoint override m | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `provider-themes.test.ts:319` every bundled theme has a complete OpenCode diff override entry | keep | OpenCode markdown override entries vs diff override entries: disjoint override m | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `chat-shell.test.tsx:2381` bounds multiline overflow to six preview rows and reports hidden logical lines | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `chat-shell.test.tsx:2409` keeps exactly six lines of output non-expandable even with a trailing newline | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `compaction.test.ts:373` does not summarize history already covered by the recent budget | keep | Two distinct compaction guards: history already inside the recent budget vs all  | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `compaction.test.ts:404` does not summarize when all complete history fits recent budget | keep | Two distinct compaction guards: history already inside the recent budget vs all  | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `markdown-message-part.test.tsx:379` keeps the settled head visible as a trailing code fence grows | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `markdown-message-part.test.tsx:446` streaming growth keeps previously rendered content | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `new-session-view-focus.test.tsx:1499` rejects an untrusted Agent pin before credential, store, or Provider construction | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `new-session-view-focus.test.tsx:1533` rejects an ambiguous Agent pin before credential, store, or Provider construction | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `user-message.test.ts:18` accepts complete skill metadata | keep | Complete skill metadata vs activation metadata without instructions: the second  | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `user-message.test.ts:35` accepts sanitized activation metadata without instructions | keep | Complete skill metadata vs activation metadata without instructions: the second  | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `settings-dialog.test.tsx:188` search reports no matching settings without hiding the hub | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `settings-dialog.test.tsx:207` search fuzzy-matches settings with subsequences across words | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `tools-versioned-editing.test.ts:657` hashline insertion after an EOF-newline anchor keeps the EOF newline | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `tools-versioned-editing.test.ts:673` hashline insertion preserves a missing final newline | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 5 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `use-git-branch.test.tsx:55` resolves an SSH origin to the repository browser URL | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `use-git-branch.test.tsx:69` preserves HTTPS origins when resolving the repository browser URL | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `client.test.ts:165` resolves relative cwd against the workspace and normalizes it | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 2 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `client.test.ts:182` keeps absolute cwd as-is | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `scalar-predicates.test.ts:21` accepts non-empty strings without trimming | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 1 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |
| `scalar-predicates.test.ts:35` accepts strings including empty strings | review-candidate | near-duplicate, kill-set inconclusive | none — no survivor subsumes it | 0 lines / 0 branches | partial: no asymmetric kill observed | keep; no action | pending (no change applied) | n/a |

82 rows. Blackbox tests (zero covered application lines) and the 7 ambiguous-name tests are recorded here as protected, not as candidates:

| Test | Category | Reason |
|---|---|---|
| `sdk-consumer.test.ts` core-only external SDK consumer imports and streams under Bun | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-consumer.test.ts` OpenAI-factory external consumer imports and chats under Bun | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-consumer.test.ts` Anthropic-factory external consumer imports and chats under Bun | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-consumer.test.ts` Anthropic-factory external consumer imports and chats under Node | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-consumer.test.ts` core-only external SDK consumer imports and streams under Node | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-consumer.test.ts` OpenAI-factory external consumer imports and chats under Node | blackbox | covers no application line: subprocess or generated-data assertion |
| `generator-graph.test.ts` bundles generators without importing generated output (#57) | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-openai-compatible-consumer.test.ts` external DeepSeek and OpenRouter SDK consumer works under Bun | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-openai-compatible-consumer.test.ts` external DeepSeek and OpenRouter SDK consumer works under Node | blackbox | covers no application line: subprocess or generated-data assertion |
| `sdk-anthropic-import-isolation.test.ts` Anthropic factory bundles without peer providers or aggregate metadata | blackbox | covers no application line: subprocess or generated-data assertion |
| `provider-model-catalog.test.ts` family metadata stays scoped to its provider route | blackbox | covers no application line: subprocess or generated-data assertion |
| `provider-model-catalog.test.ts` routed context policy follows explicit model family, not model name | blackbox | covers no application line: subprocess or generated-data assertion |
| ... | blackbox | 37 more: the remaining `provider-model-catalog`, `sdk-consumer*`, `executable`, `test-entrypoint` and `distribution` cases |

## 12. Verification of this audit

| Check | Result |
|---|---|
| Per-test contexts captured | Partial by design: Bun has no dynamic contexts. 2542 isolated runs; 7 ambiguous-name cases flagged; no branch data exists (0 `BRDA` records). |
| No deletion rests on coverage equality | Holds: 0 deletions proposed. The 12 identical-coverage clusters were reviewed individually; 12 are keeps. |
| Quarantine before removal | Not applicable: nothing was removed or quarantined. The log records zero deletions, so `git log --diff-filter=D -- tests/` is unchanged. |
| Tiers select correctly | Not applicable: markers were not applied. The proposed table is in section 10. |
| Audit record complete | Every flagged row has category, superseded-by, coverage delta, mutation-check status, action and approver state. |
| Reproducible | `scripts/test-curation/` runs the whole pipeline; `report.ts` regenerates this file from the artifacts. |

## 13. If this proceeds

1. This run finds no merge candidate. The one the previous audit found (`summary-generator.test.ts`, output-limit vs filtered) is now a single table-driven test in commit `7d2d57a6`; it kept both inputs and the shared oracle.
2. `session-host.test.ts`'s Google-cache test is fixed at the root: the volatile environment block left the cacheable system prefix, so live repository churn no longer invalidates the second Host's Cache. The test keeps running against the repository workspace as the regression check, and no quarantine was needed.
3. If any candidate is ever quarantined under a different review, follow the skill's order: skip/xfail with the log row id, named approver, two-release observation window, escaped-defect watch, then delete in small batches with `mutation_check: yes` recorded per row.
4. Do not prune on coverage: in this repo, 90% of covered lines are shared and 131 test groups are coverage-identical, so a coverage-driven prune would have flagged real oracles as redundant 12 times out of 12.
