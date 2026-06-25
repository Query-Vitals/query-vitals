# Query Monitoring Flow

This document describes how Query Vitals goes from "a query ran on the database" to "a scored, indexed-or-not record with a suggestion on screen." The pipeline is the same for both engines; only the collection source and the plan parsing differ, and both differences are hidden behind the `IDatabaseConnector` port.

## Where the queries come from

Query Vitals never intercepts traffic or proxies the connection. It reads the observability surfaces the databases already expose, which keeps overhead low and requires no driver shims in the user's own app.

For **MySQL 8+**, the primary source is `performance_schema`, specifically `events_statements_summary_by_digest`. This table already groups statements by digest (MySQL's own normalized fingerprint) and tracks execution count, total/average/max latency, and rows examined vs. rows sent. Reading it on an interval gives accurate aggregates with negligible cost. When `performance_schema` is disabled or the account lacks access, the connector falls back to tailing the slow query log. The `test()` call reports which path is available via `monitoringCapable` and `missingCapabilities`, so the UI can tell the user exactly what privilege to grant before they save.

For **MongoDB 5+**, the source is the database profiler. The connector enables profiling at level 1 with a configurable `slowms` threshold and tails the capped `system.profile` collection, which records the command, namespace, duration, `docsExamined`, `keysExamined`, and `nreturned`. Existing-index usage for the unused-index rule comes from the `$indexStats` aggregation stage.

In both cases the user can also paste a query directly into the analyzer (`source: 'manual'`), which skips collection and runs straight through explain + analysis — useful for checking a query before shipping it.

## The poll loop

One `IQueryCollector` runs per active connection, managed by the `ICollectorManager`. Starting monitoring kicks off an interval (default configurable via `MonitoringSettings.pollIntervalMs`). Each tick does the following:

1. Call `connector.collectSince(checkpoint)`. The adapter returns the queries observed since the last cursor plus a `nextCheckpoint`. For MySQL the checkpoint is tracked against the digest table snapshot; for MongoDB it is the last profiler timestamp. Tracking a checkpoint means each query is processed once and the loop never reprocesses the whole table.
2. Hand each raw query to the `IQueryAnalyzer`.
3. Upsert the resulting digests into `IQueryHistoryRepository` (merging counts and recomputing averages when the fingerprint already exists).
4. Fold the tick's records into one per-fingerprint **workload sample** — execution count, cumulative time, rows examined/returned, and index usage over the window `[previous tick, now]` — and append them to `IWorkloadSampleRepository`. Unlike the all-time digests in (3), these retain the short-window temporal grain the workload analyzer needs (see below). Only read query types are sampled, and samples older than 24h are pruned on the same cadence as history.
5. Emit a `queries` event, which the main process forwards to the renderer as `events:queriesCaptured` so the live table updates without UI-side polling.

The collector exposes `start`, `pause`, `resume`, and `stop`, and surfaces `state`, `status`, and `error` events so the UI can show "monitoring," "paused," or a connection problem honestly rather than silently stalling.

## Normalization and fingerprinting

Before analysis, the analyzer normalizes each statement so that a thousand runs of the same query with different literal values collapse into one digest. For SQL this uses `node-sql-parser` to replace literals with `?` placeholders and to extract the query type, the target table(s), and any joined tables. For MongoDB the command document is canonicalized — field names are kept, values are replaced with placeholders — to produce the equivalent fingerprint. The fingerprint (a hash of the normalized form plus database and target) is the grouping key everywhere: in the history table, the dashboard rankings, and the `sourceFingerprints` that tie a recommendation back to the queries that motivated it.

## Analysis

For each normalized query the analyzer calls `connector.explain(...)`. The adapter runs the engine's plan command — `EXPLAIN FORMAT=JSON` for MySQL, `explain("executionStats")` for MongoDB — and is responsible for translating the engine-specific output into the shared shapes. This is where the two worlds become one vocabulary:

- **Index usage** — MySQL: the access `type` is better than `ALL` and a `key` is chosen. MongoDB: an `IXSCAN` stage appears in the winning plan.
- **Full table scan** — MySQL `type = ALL`.
- **Collection scan** — MongoDB `COLLSCAN` stage.
- **Rows/documents examined vs. returned** — MySQL `rows_examined_per_scan` vs. `rows_sent`; MongoDB `totalDocsExamined`/`totalKeysExamined` vs. `nreturned`.
- **Selectivity** — `rowsReturned / rowsExamined`, capped at 1. A low value means the engine read far more than it returned, which is the clearest signal that an index is missing or poorly ordered.

The adapter also flattens the plan into an `ExecutionPlanNode` tree (stage label, target, index name, rows, cost, a plain-language `detail`) for display, while keeping the raw plan JSON under `rawPlan` for power users who want the unabridged output.

## Scoring

The analysis is reduced to a single 0–100 performance score (`src/main/domain/value-objects/scoring.ts`) so the dashboard and detail screen can summarize health at a glance. The score is a weighted blend of four normalized factors: index usage (0.40), selectivity (0.25), a scan penalty that zeroes out on a full/collection scan (0.20), and a latency term that decays past the slow threshold (0.15). The weights are explicit constants precisely so they can be retuned against real-world data without touching the rest of the pipeline, and the per-factor breakdown is stored alongside the score so the UI can explain *why* a query scored the way it did.

## Recommendations

The recommendation engine runs over the accumulated digests plus the connection's existing indexes (`connector.listIndexes`). It is pure and deterministic. For missing and composite/compound indexes it looks at the predicates, range conditions, and sort fields of scanning or low-selectivity queries, then orders the proposed index columns by the standard rule — equality predicates first, then range conditions, then sort columns — and emits a ready-to-run statement. For example, `SELECT * FROM orders WHERE user_id = ? AND status = ? ORDER BY created_at DESC` yields `CREATE INDEX idx_orders_user_status_created ON orders(user_id, status, created_at)`. For MySQL it flags redundant indexes that are a prefix of (or duplicate of) another. For MongoDB it flags indexes whose `$indexStats` access count stayed at zero across the observation window. Each recommendation carries a rationale, an estimated impact, and the fingerprints that motivated it, and can be dismissed so it stops resurfacing.

## Workload pattern insights

Some performance problems are invisible when each query is judged alone: a page or request that fires the same fast point lookup once per row of a parent result — the classic N+1 — looks healthy in every digest, because the cost is in the repetition, not in any single execution. The all-time digests in `query_history` cannot see this, since they collapse every run of a fingerprint into one row with no sense of *when* the runs clustered. That is what the per-tick workload samples (step 4 above) are for.

The pure `WorkloadAnalyzer` (`src/main/application/workload`) reads the recent samples for a connection, groups them by fingerprint, and merges samples that fall close together in time into bursts. A burst is flagged when its query is a repeated *point lookup* — a SELECT/find whose predicate is equality-only on one or two key-shaped columns, the shape that collapses into `IN (...)` / `$in` / a join when batched — and it ran more than a threshold number of times in the window. Insights are scored by *cumulative* cost (execution count, window duration, total time, rows examined) rather than per-query latency, and carry engine-specific remediation: SQL bursts point to `IN (...)`, a JOIN, or eager-loading; MongoDB bursts to `$in`, `$lookup`, denormalization, or prefetching. A burst on an already-indexed query is explicitly labelled "indexed but repeated" and told that another index will not help.

These insights are deliberately kept on their own screen, separate from index suggestions, so the app never recommends another index when the real fix is query orchestration. The first version is useful without any framework instrumentation; the sample shape leaves room to correlate by `traceId`/`requestId` later.

## End-to-end summary

A query runs → the collector reads it from `performance_schema`/the profiler on the next tick → the analyzer normalizes it, fingerprints it, runs explain, and scores it → the digest is upserted into local SQLite and a per-window sample is appended → a push event updates the live table → the dashboard aggregates feed the metric cards and rankings → the recommendation engine periodically turns the worst offenders into copy-ready index suggestions → the workload analyzer turns repeated-lookup bursts in the samples into N+1 insights. None of the steps above the connector adapters know or care whether the engine is MySQL or MongoDB.
