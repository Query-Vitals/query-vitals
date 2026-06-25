# Query Vitals

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Built with Electron](https://img.shields.io/badge/Electron-desktop-47848f.svg)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-first-3178c6.svg)](https://www.typescriptlang.org/)
[![Local first](https://img.shields.io/badge/Local--first-no%20cloud-111827.svg)](#privacy)
[![Website](https://img.shields.io/badge/Website-queryvitals.com-0f766e.svg)](https://queryvitals.com)

A dark-mode-first desktop app that diagnoses **MySQL 8+** and **MongoDB 5+** query performance — from missing indexes and full scans to repeated workload patterns such as N+1 queries.

It connects to a database, continuously observes the queries running against it, runs each through the engine's own execution-plan tooling, and reports a normalized diagnosis with a 0–100 performance score, copy-ready index suggestions, and workload insights. Everything is stored locally; there is no cloud dependency.

## Screenshots

**Dashboard** — metric cards, query volume & latency over time, and ranked top queries.

![Query Vitals dashboard](pictures/demo%20dashboard.png)

**Live monitoring** — captured queries scored 0–100 in real time, with full-scan and index status at a glance.

![Live query monitoring](pictures/demo%20monitoring%20query.png)

**Query detail** — raw query, normalized fingerprint, execution plan, performance breakdown, and a copy-ready `CREATE INDEX` recommendation.

![Query detail and execution plan](pictures/demo%20execution%20query.png)

**Workload insights** — deterministic N+1 / repeated-lookup detection, scored by cumulative cost with a concrete batching fix.

![Workload N+1 detection](pictures/demo%20workload%20n+1%20detect.png)

## Why

Slow database queries often hide behind vague symptoms: high CPU, long page loads, or a dashboard that "just feels slower today." Query Vitals turns engine-native query telemetry into a practical diagnosis: which queries are scanning too much, which indexes are missing or redundant, which query patterns are repeated too often, and what change is likely to help.

## Status

Phase 6 — workload pattern insights. On top of the polished MySQL/MongoDB core, the app now detects performance problems that only appear across a burst of queries: deterministic N+1 detection flags repeated, similarly-shaped point lookups that are individually fast but costly in aggregate, scored by cumulative cost and shown on a dedicated Workload screen separate from index suggestions.

The core local-first product is feature-complete for MySQL 8+ and MongoDB 5+: it can connect to databases, monitor query activity, normalize execution plans, score query performance, surface slow/full-scan patterns, generate copy-ready index recommendations with estimated impact and dismissal support, and surface repeated-lookup (N+1) workload patterns. Next planned work is Phase 7 PostgreSQL parity, followed by Phase 8 optional AI query optimization.

## Features

- Local-only desktop monitoring for MySQL 8+ and MongoDB 5+.
- Connection management with capability checks and keychain-backed secrets.
- Continuous query collection through engine-native telemetry.
- Normalized execution-plan analysis with a shared 0-100 performance score.
- Live monitoring, query detail, dashboard metrics, rankings, and time-series charts.
- Rule-based recommendations for missing, composite, compound, redundant, and unused indexes.
- Estimated-impact figures and dismissible suggestions.
- Workload pattern insights: deterministic N+1 / repeated point-lookup detection scored by cumulative cost.
- Cross-platform packaging through `electron-builder`.

## Privacy

Query Vitals is local-first by design:

- No account is required.
- No cloud service is required.
- Query history, recommendations, and settings stay on your machine.
- Database passwords are stored through the OS keychain, not in SQLite.
- Future AI features are planned as optional and disabled by default.

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — process model, clean-architecture layers, the connector port, data flow, tech decisions.
- [`docs/MONITORING_FLOW.md`](docs/MONITORING_FLOW.md) — how a query becomes a scored, analyzed record with a suggestion.
- [`docs/ROADMAP.md`](docs/ROADMAP.md) — phased delivery plan from MVP to full feature set.

## Stack

Electron · React · TypeScript · TailwindCSS · Zustand · Recharts on the front; Node.js · `mysql2` · `mongodb` · `sql.js` (WASM SQLite, no native build) on the back. Build via `electron-vite`, package via `electron-builder`.

## Quick start

```bash
git clone <repository-url>
cd query-vitals
npm install
npm run dev
```

## Layout

```
src/
  main/            Electron main process (Node backend)
    domain/        entities, value-objects, repository + service interfaces (no I/O)
    application/   use-case orchestration over domain interfaces
    infrastructure/connectors (mysql, mongodb), SQLite persistence, collectors
    ipc/           ipcMain handlers
    bootstrap/     composition root (the only place concretes are constructed)
  preload/         typed contextBridge exposing window.api
  renderer/        React UI (feature-based)
    src/features/  connections, monitoring, analysis, suggestions, workload, dashboard, query-detail
    src/shared/    ui, hooks, lib, store (zustand)
  shared/          cross-process types + the IPC contract (no Node/Electron imports)
```

## Develop

```bash
npm install
npm run dev        # electron-vite dev with hot reload
npm run typecheck  # tsc --noEmit
npm run test       # vitest (analyzer + recommendation rules)
npm run build      # production build
```

## Roadmap

- **Phase 5:** polish and packaging for the MySQL/MongoDB product. _(done)_
- **Phase 6:** workload pattern insights, including N+1 and repeated point-lookup detection. _(done)_
- **Phase 7:** PostgreSQL parity with `pg_stat_statements`, PostgreSQL plan parsing, and Postgres-specific recommendations.
- **Phase 8:** optional AI query optimization behind a provider port.

See [`docs/ROADMAP.md`](docs/ROADMAP.md) for the full phased plan.

## The dependency rule

The whole codebase above the engine adapters depends only on the `IDatabaseConnector` interface — never on `mysql2` or `mongodb` directly. Each adapter normalizes its engine's plan output into one shared vocabulary, so the analyzer, recommendation engine, and UI are engine-agnostic. Adding a new database later means writing one adapter and updating the factory.

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request, especially if your change touches database connectors, IPC boundaries, storage, or security-sensitive behavior.

## Security

Please do not report vulnerabilities in public issues. See [`SECURITY.md`](SECURITY.md) for the current reporting process and security boundaries.

## License

Query Vitals is open source under the [MIT License](LICENSE).
