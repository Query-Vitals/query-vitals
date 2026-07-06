# Query Vitals

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Built with Electron](https://img.shields.io/badge/Electron-desktop-47848f.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178c6.svg)](https://www.typescriptlang.org/)
[![Local first](https://img.shields.io/badge/Local--first-no%20cloud-111827.svg)](#privacy)
[![Website](https://img.shields.io/badge/Website-queryvitals.com-0f766e.svg)](https://queryvitals.com)

A dark-mode-first desktop app that diagnoses **MySQL 8+**, **PostgreSQL 13+**, and **MongoDB 5+** query performance — from missing indexes and full scans to N+1 workload patterns. It watches the queries running against your database, runs each through the engine's own execution-plan tooling, and reports a 0–100 performance score with copy-ready index suggestions. Everything stays on your machine.

**Status:** feature-complete for all three engines. Next up: optional AI query optimization — see [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Screenshots

**Dashboard** — metric cards, query volume & latency over time, and ranked top queries.

![Query Vitals dashboard](pictures/demo%20dashboard.png)

**Live monitoring** — captured queries scored 0–100 in real time, with full-scan and index status at a glance.

![Live query monitoring](pictures/demo%20monitoring%20query.png)

**Query detail** — raw query, normalized fingerprint, execution plan, performance breakdown, and a copy-ready `CREATE INDEX` recommendation.

![Query detail and execution plan](pictures/demo%20execution%20query.png)

**Workload insights** — deterministic N+1 / repeated-lookup detection, scored by cumulative cost with a concrete batching fix.

![Workload N+1 detection](pictures/demo%20workload%20n+1%20detect.png)

## Features

- Continuous local-only query collection via engine-native telemetry (`performance_schema`, `pg_stat_statements`, MongoDB profiler).
- Normalized execution-plan analysis with a shared 0–100 performance score across engines.
- Copy-ready recommendations with estimated impact — missing, composite, redundant, and unused indexes, plus Postgres expression and GIN indexes.
- Deterministic N+1 / repeated point-lookup detection scored by cumulative cost.
- Dashboard with metric cards, query rankings, and volume/latency time series.
- Connection management with capability checks and keychain-backed secrets.

## Privacy

Local-first by design: no account, no cloud service. Query history, recommendations, and settings stay on your machine; database passwords go to the OS keychain, never to SQLite. Future AI features are planned as optional and disabled by default.

## Quick start

```bash
git clone <repository-url>
cd query-vitals
npm install
npm run dev        # electron-vite dev with hot reload
```

Other scripts: `npm run typecheck`, `npm run test`, `npm run build`.

Built with Electron, React, TypeScript, and TailwindCSS on the front; Node.js with `mysql2` / `pg` / `mongodb` drivers and `sql.js` (WASM SQLite, no native build) on the back.

## Learn more

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process model, clean-architecture layers, repository layout, the connector port.
- [`docs/MONITORING_FLOW.md`](docs/MONITORING_FLOW.md) — how a query becomes a scored, analyzed record with a suggestion.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased delivery plan from MVP to full feature set.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — please read before opening a pull request.
- [`SECURITY.md`](SECURITY.md) — report vulnerabilities privately, not in public issues.

## License

Query Vitals is open source under the [MIT License](LICENSE).
