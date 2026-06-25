# dashboard

The analytical surface over accumulated query history for the active
connection, scoped to a rolling 24h window.

It renders the metric cards (total, indexed, non-indexed, slow, average time,
index coverage), a Recharts time series of query latency (area) and volume
(line), and a switchable ranking table covering the four rankings — slowest,
most-executed, full scans, and poor selectivity. All data is fetched through
`api.dashboard.*`, which the SQLite history repository serves with aggregate
SQL; the screen stays engine-agnostic, so MySQL and MongoDB render identically.
