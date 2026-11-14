# Test curation harness

Read-only tooling behind [`docs/test-curation-log.md`](../../docs/test-curation-log.md). It fingerprints the Default Test Portfolio, clusters near-duplicates, mines defect history, and confirms candidate redundancy with kill-sets before anything is proposed for quarantine.

The harness never edits, skips, deletes, or retags a test. Mutants are applied inside a detached git worktree.

## Prerequisites

- Bun 1.4 and the repository installed (`bun install`).
- Full git history: defect history and the revert arm read `fix:` commits.
- No archived per-test CI history is required; `flake.ts` produces its own same-commit runs.
- `gh` is only needed if you also want job-level CI context, which no disposition uses.

## Run order

Artifacts default to `.tmp/test-curation/` (git-ignored and excluded from Biome). Override the location with `CURATION_ARTIFACTS=/path`.

```sh
bun scripts/test-curation/baseline.ts run1            # ~2 min, per-test JUnit outcomes
bun scripts/test-curation/per-file-coverage.ts 6      # ~3 min, one lcov run per test file
bun scripts/test-curation/fingerprint.ts              # seconds
bun scripts/test-curation/per-test-coverage.ts 8 run1 # ~2 min, one run per test case
bun scripts/test-curation/cluster.ts                  # seconds, must precede analysis.ts
bun scripts/test-curation/analysis.ts                 # seconds
bun scripts/test-curation/history.ts                  # ~1 min, fix commits and churn
bun scripts/test-curation/baseline.ts run2            # flake arm needs >= 2 runs
bun scripts/test-curation/baseline.ts run3
bun scripts/test-curation/flake.ts run1 run2 run3
bun scripts/test-curation/obsolete.ts                 # seconds, unresolved imports
bun scripts/test-curation/faults.ts                   # ~5 min, operator mutants
bun scripts/test-curation/reverts.ts                  # ~2 min, historical fix reverts
bun scripts/test-curation/report.ts                   # rewrites docs/test-curation-log.md
```

`faults.ts` defaults to the clusters named in the log. Select others with `--files a.test.ts,b.test.ts`; pass `--worktree <dir>` to reuse an existing detached worktree instead of creating and removing one.

## Artifacts

```
.tmp/test-curation/
  junit/<label>/<package>.xml     per-test outcomes per run
  timings/<label>-<package>.json  per-file durations
  cov/<test-file>/lcov.info       per-file coverage shards
  cov-tests/                      transient per-test coverage runs
  logs/                           runner output, per step
  worktree/                       transient fault-injection worktree
  analysis/
    baseline-<label>.json
    coverage-runs.json
    fingerprints.json             per-file line sets and unique-line counts
    subsumption.json              file-level subsumption and equality pairs
    per-test-fingerprints.jsonl   one row per test case, covered line ids
    per-test-line-index.json      line id -> path:line
    coverage-analysis.json        equality groups, cluster overlap, protection list
    ast-clusters.json             clusters, scores, identical files
    history.json                  fix commits, added tests, churn
    flakes.json                   same-commit divergence
    obsolete.json                 unresolved relative imports
    fault-injection.json          operator-mutant kill sets
    revert-injection.json         historical-fix kill sets
```

## How to read the output

- **Coverage equality is not redundancy.** Bun has no per-test coverage contexts, and most covered lines come from loading the module graph, so identical line sets are common and weak evidence. Only `faults.ts` and `reverts.ts` produce evidence that one test subsumes another: a defect the survivor catches that the peer misses proves the pair is distinct.
- **Clusters are review candidates.** `cluster.ts` requires both structural similarity (>= 0.85) and literal-preserving similarity (>= 0.70) over at least 20 tokens, and still only proposes groups for a human to read.
- **Zero-coverage tests are protected.** A test that spawns a subprocess or asserts generated data covers no application line; coverage cannot justify removing it.
- **Never-failing is not low-value.** `flake.ts` reports same-commit divergence, not absence of failures. A test that never failed usually guards stable, low-churn code.
- **Dispositions are four different actions.** Redundant (quarantine after a kill-set), obsolete (delete only after confirming the target is gone), low-value (quarantine and review), keep. This harness reports; it does not remove.

## Limits

- Line coverage only: Bun's lcov reporter emits no `BRDA` records, so no branch data exists.
- Per-test coverage comes from running each test alone (`-t`), which discards cross-test state; tests with duplicate names are recorded as ambiguous unions.
- The revert arm reverse-applies only the cluster's subject module; a reverted fix can still touch shared code, so a detection there is weaker evidence than an asymmetric operator mutant.
- Numbers describe one commit. Re-run after large refactors rather than citing a stale log.
