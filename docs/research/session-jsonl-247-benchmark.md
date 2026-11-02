# Session JSONL benchmark results

Measured on 2026-11-02 with the repository benchmark harness, using temporary databases and logs. The project pins Bun 1.4.2; this host ran Bun 1.3.14, so these numbers are local measurements, not pinned-runtime release evidence.

## Environment

- macOS Darwin 24.6.0, arm64, Apple M1, 16 GiB RAM
- 30 warm samples per query; RSS sampled during measured phases
- All Sessions share timestamp `2026-10-31T00:00:00.000Z` to exercise stable ordering
- Fixture logs are generated without per-event sync; the appended catch-up event is synced. Cold reads use the normal sync policy.

Raw reports: [`session-jsonl-247-catalog-benchmark.json`](session-jsonl-247-catalog-benchmark.json), [`session-jsonl-247-statistics-benchmark.json`](session-jsonl-247-statistics-benchmark.json), and [`session-jsonl-247-combined-benchmark.json`](session-jsonl-247-combined-benchmark.json).

## 10,000 Sessions / 500 checkpoints

| Phase | Result | Peak RSS |
| --- | ---: | ---: |
| Cold discovery (10,000 Sessions, no issues) | 42.37 s | 176.6 MB |
| Cold rebuild (10,000 Sessions, no issues) | 33.06 s | 318.9 MB |
| Catch-up (one appended checkpoint) | 23.34 ms | 142.8 MB |
| Cold statistics | 5.83 ms | 132.2 MB |
| Warm catalog, limit 50 | median 1,016.8 ms; p95 1,434.4 ms | — |
| Warm catalog, limit 200 | median 1,054.4 ms; p95 2,986.6 ms | — |
| Warm history, limit 50 | median 2.93 ms; p95 7.32 ms | — |
| Warm history, limit 200 | median 4.07 ms; p95 6.00 ms | — |
| Warm statistics | median 2.52 ms; p95 5.01 ms | — |

## 201 Sessions / 100,000 checkpoints

Cold discovery was skipped for this fixture; the 10,000-Session run above measures discovery.

| Phase | Result | Peak RSS |
| --- | ---: | ---: |
| Cold rebuild (201 Sessions, no issues) | 709.70 s | 774.7 MB |
| Catch-up (one appended checkpoint) | 2.55 s | 1,223.1 MB |
| Cold statistics | 320.74 ms | 1,253.1 MB |
| Warm history, limit 50 | median 24.52 ms; p95 30.59 ms | — |
| Warm history, limit 200 | median 25.82 ms; p95 27.60 ms | — |
| Warm statistics | median 114.69 ms; p95 296.08 ms | — |

## 10,000 Sessions / 100,000 checkpoints (combined)

This fixture has 10,000 Sessions, with all 100,000 checkpoints in one Session. It completed after the suffix-catch-up and statistics optimizations.

| Phase | Result | Peak RSS |
| --- | ---: | ---: |
| Cold discovery (10,000 Sessions, no issues) | 443.29 s | 806.8 MB |
| Cold rebuild (10,000 Sessions, no issues) | 429.61 s | 1,350.6 MB |
| Catch-up (one appended checkpoint) | 198.61 ms | 913.3 MB |
| Cold statistics | 284.98 ms | 316.8 MB |
| Warm catalog, limit 50 | median 595.36 ms; p95 967.51 ms | — |
| Warm catalog, limit 200 | median 588.12 ms; p95 859.95 ms | — |
| Warm history, limit 50 | median 15.99 ms; p95 17.53 ms | — |
| Warm history, limit 200 | median 17.03 ms; p95 18.69 ms | — |
| Warm statistics | median 69.36 ms; p95 93.86 ms | — |

The combined report confirms page sizes 50/200, same-timestamp ordering, fixed catalog/history snapshots after status revisions, and no rebuild issues. Query-plan index use is separately asserted by the Session SDK tests.

## Limits and follow-up

- These measurements cover macOS only. They do not establish Linux/Windows lock or sync behavior, nor guarantees for every filesystem or storage device.
- The warm catalog path still stats each bound Session log before taking a fresh snapshot. Across the 10,000-Session fixtures, median latency ranged from 0.59–1.05 s and p95 from 0.86–2.99 s. It does not parse every transcript or hydrate every attachment, but remains O(number of bound Sessions). A marker-only shortcut was rejected because write-intent markers can be cleared before projection catch-up; an optimization must preserve fresh-read recovery and publication visibility.

Run the harness with `bun run --cwd packages/coding-agent bench:session-jsonl`. Set `BENCH_SESSIONS`, `BENCH_CHECKPOINTS`, `BENCH_SKIP_DISCOVERY=1` (for the smaller large-checkpoint fixture), and `BENCH_REPORT_PATH` to choose the fixture and report destination. The combined fixture was run with `BENCH_SESSIONS=10000 BENCH_CHECKPOINTS=100000 BENCH_REPORT_PATH=../../docs/research/session-jsonl-247-combined-benchmark.json`.
