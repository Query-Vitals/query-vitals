# workload

`WorkloadService` computes workload-pattern insights on demand from the recent
sample window (read-through, like dashboard rankings — insights are derived, not
stored). The pure `WorkloadAnalyzer` holds the rules:

- **N+1 detection** — group per-window samples by fingerprint, merge samples
  within `burstGapMs` into bursts, and flag a burst when the normalized query is
  a repeated _point lookup_ (a SELECT/find whose predicate is equality-only on
  one or two key-shaped columns) that ran at least `minExecutions` times.
- **Cost scoring** — severity and ordering come from _cumulative_ cost
  (execution count, window duration, total time, rows examined), not per-query
  latency: each execution may look healthy; the cost is the repetition.
- **Engine-aware remediation** — SQL bursts suggest `IN (...)` / a JOIN /
  eager-loading; MongoDB bursts suggest `$in` / `$lookup` / denormalization /
  prefetching. An "indexed but repeated" burst is explicitly told that another
  index will not help.

Samples come from `workload_samples`, written by the collector each poll tick —
`query_history` keeps only all-time digests, which cannot see the short windows
an N+1 pattern lives in. The analyzer is pure: same samples + options → same
insights, so the burst-grouping and shape-detection logic is unit-testable
without a database.
