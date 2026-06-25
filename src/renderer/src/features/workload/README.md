# workload

Workload-pattern insights grouped by severity. Each card shows the headline
("84 similar queries in 2.3s"), cumulative-cost stats (executions, window,
cumulative time, avg/query, rows examined), the plain-language rationale and
remediation, and the normalized query. Badges flag "indexed but repeated" vs
"not indexed" and "batching candidate". Deliberately separate from the
Suggestions screen — these are query-orchestration problems, not missing indexes.
