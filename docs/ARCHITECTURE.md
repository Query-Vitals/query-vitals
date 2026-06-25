# Query Vitals — System Architecture

Query Vitals is a cross-platform desktop application that helps developers diagnose MySQL and MongoDB query performance. It connects to a database, continuously observes the queries running against it, runs each one through the engine's own execution-plan tooling, and turns the result into a normalized diagnosis: indexed or not, scanning or not, fast or slow, repeated too often or not — plus concrete, copy-ready index suggestions and workload insights.

This document covers the process model, the layered architecture, the dependency rule that keeps the code engine-agnostic, the data flow, and the key technical decisions. The folder layout is described inline; the monitoring pipeline has its own document (`MONITORING_FLOW.md`) and the delivery plan lives in `ROADMAP.md`.

## Process model

The app is an Electron application with three runtime contexts, isolated for security:

The **main process** is the Node.js backend. It owns every privileged capability: opening TCP connections to databases, reading the local SQLite history file, and talking to the OS keychain. All database drivers (`mysql2`, `mongodb`) and persistence (`better-sqlite3`) run here and nowhere else. This is deliberate — the renderer is treated as untrusted and never gets direct network or filesystem access.

The **renderer process** is the React UI. It runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. It holds no business logic beyond presentation and view state; everything it needs comes from the main process through a typed bridge.

The **preload script** is the only bridge between the two. Using `contextBridge`, it exposes a small, strongly-typed `window.api` object whose shape is defined once in `src/shared/contracts/ipc.ts`. The renderer calls `window.api.queries.list(...)`; the preload forwards it over `ipcRenderer.invoke`; the main process handles it. Neither side hand-writes channel strings — they share the `IpcChannels` constant — so a renamed channel is a compile error, not a silent runtime failure.

## Layered (clean) architecture

Inside the main process the code follows clean architecture. Dependencies point inward only: outer layers know about inner layers, never the reverse. The four layers are domain, application, infrastructure, and the IPC/presentation edge.

The **domain layer** (`src/main/domain`) is the core. It contains entities and value objects (the query record shape, the performance-score calculation), repository *interfaces*, and service *interfaces* (the database connector port, the analyzer, the recommendation engine, the collector). It has zero dependencies on Electron, `mysql2`, `mongodb`, or SQLite. It is pure TypeScript and pure logic, which is exactly what makes it testable in isolation.

The **application layer** (`src/main/application`) orchestrates use cases by composing domain services: "test and save a connection," "start monitoring a connection," "run the recommendation engine and persist results." It depends on domain interfaces, not concrete classes.

The **infrastructure layer** (`src/main/infrastructure`) provides the concrete implementations the domain only describes: the MySQL and MongoDB connector adapters, the SQLite-backed repositories, the keychain-backed secret store, and the polling collectors. This is the only layer allowed to import third-party drivers.

The **IPC/presentation edge** (`src/main/ipc`, plus `src/preload` and `src/renderer`) translates between the outside world and the application layer. Handlers receive an IPC call, invoke an application service, and return a serializable result.

Everything is wired together in one place: the composition root at `src/main/bootstrap/container.ts`. It is the single location where concrete classes are constructed and handed to services as interfaces. This keeps the rest of the codebase free of `new MySqlConnector()`-style coupling and makes swapping an implementation (for example, an in-memory repository in tests) a one-line change.

### The dependency rule in practice — the connector port

The most important seam in the system is `IDatabaseConnector` (`src/main/domain/services/database-connector.ts`). MySQL and MongoDB are profoundly different — SQL text vs. command documents, `EXPLAIN FORMAT=JSON` vs. `explain("executionStats")`, `performance_schema` vs. the profiler collection — yet the analyzer, the collectors, the recommendation engine, and the entire UI must not care which engine is on the other end.

The port solves this. Each engine has an adapter (`MySqlConnector`, `MongoConnector`) that implements the same interface: `test`, `connect`, `disconnect`, `explain`, `listIndexes`, and `collectSince`. The `ConnectorFactory` builds the right adapter from a connection config. Crucially, the adapter is responsible for normalizing engine-specific plan output into the shared `IndexAnalysis` and `ExecutionPlanNode` shapes. Everything above the adapter sees one engine-agnostic vocabulary: "uses index," "full scan," "rows examined," "rows returned," "selectivity." Adding a third engine later (PostgreSQL, say) means writing one new adapter and changing the factory — nothing else.

### The same pattern for AI — the LLM provider port

AI query optimization (Phase 8 in `ROADMAP.md`) follows the connector pattern exactly, for the same reason: the application and UI must not care which model — or whether a local or cloud model — produced an explanation. A second port, `ILlmProvider` (`src/main/domain/services/llm-provider.ts`), abstracts the model behind a small interface such as `isAvailable`, `optimizeQuery`, `explainPlan`, and `adviseSchema`, each taking the already-normalized analysis the app produced and returning a structured result (a query diff with rationale, a plan narration, schema suggestions). Two adapters implement it: a **local** adapter against an OpenAI-compatible localhost endpoint (Ollama), which preserves the no-cloud default, and a **cloud BYO-key** adapter (OpenAI / Anthropic). A `LlmProviderFactory` selects the adapter from the AI settings, mirroring `ConnectorFactory`.

The crucial design rule is that the model is a strictly additive consumer, never a source of truth. An `AiOptimizationService` in the application layer takes the deterministic outputs — the normalized query, the `ExecutionPlanNode` tree, the `IndexAnalysis`, and the rule-based recommendations — and passes them to the provider; the model only explains or rewrites on top of them. If no provider is configured, `isAvailable` is false and the feature simply does not appear, leaving the rule-based experience untouched. Because the provider is a domain interface, the application and renderer depend only on it, and an in-memory fake provider makes the AI use cases unit-testable without any model. Prompts are constructed in the infrastructure adapter from normalized query *shapes* and plan/index structure rather than literal parameter values, so the port also encodes the privacy boundary, not just the model boundary.

## Shared contracts

`src/shared` is compiled into both processes, so it must stay free of Node and Electron imports. It holds the cross-process vocabulary: the database/connection types, the normalized query and analysis types, the recommendation types, the workload-insight types, the dashboard metric types, and the IPC contract. Defining these once means the UI and the backend can never drift out of sync — a change to `QueryRecord` ripples through both sides as type errors until they agree again.

## Data flow

A read from the dashboard flows inward and back out. The renderer calls `window.api.dashboard.metrics(connectionId, from, to)`; the preload forwards it; the IPC handler calls the application service; the service reads from `IQueryHistoryRepository`; the SQLite implementation runs an aggregate query and returns a `DashboardMetrics` object that travels back up to the React card components.

A capture flows the other way and is push-based. A per-connection collector polls the database on an interval (via the connector's `collectSince`), normalizes and analyzes each new query through the analyzer, upserts the resulting digests into the history repository, and emits a `events:queriesCaptured` event. The main process pushes that event over IPC; the renderer's subscription updates the live monitoring table without polling from the UI side. This pipeline is the subject of `MONITORING_FLOW.md`.

## Storage and privacy

Everything is local; there is no cloud dependency. Query history, recommendations, per-window workload samples, and per-connection settings live in a single SQLite database in the OS app-data directory, accessed only through repository interfaces. Connection passwords are never written to SQLite — the config stores a `passwordRef`, and the actual secret goes to the OS keychain through the `ISecretStore` port. This means the history file can be backed up or inspected without leaking credentials. AI optimization keeps the same posture: the feature is disabled by default, the local provider sends nothing off the machine at all, and the cloud BYO-key adapter stores its API key in the keychain through that same `ISecretStore` port — never in SQLite — and sends only normalized query shapes and plan/index metadata, not literal parameter values. AI suggestions are cached against the query fingerprint so a query is not re-sent on every view.

## Key technical decisions

The connector port and the normalize-at-the-adapter rule are the foundation: they are what let a single analyzer, recommendation engine, and UI serve two very different databases. SQLite was chosen over a JSON file because the dashboard needs real aggregation, ranking, and time-bucketing over potentially large history. It runs via `sql.js` — SQLite compiled to WebAssembly — rather than a native module like `better-sqlite3`, a deliberate trade: the app installs with zero `node-gyp` compilation on any Node or Electron version (important given how often native addons break against new V8 releases), at the cost of keeping the database in memory and persisting it to disk with a debounced atomic `export()` after writes. For a local query-history tool the database is small, so this is simple and fast; the `SqliteDatabase` wrapper hides it entirely behind the repository interfaces. Zustand holds only UI state — active connection, navigation — while data fetched from the backend is cached per feature, avoiding a heavyweight global cache. Recharts renders the dashboard time series. The recommendation engine is written as a set of pure functions over analyzed queries and existing indexes, which makes its rules (column ordering, prefix redundancy, unused-index detection) directly unit-testable without a live database. The AI layer added later sits behind the `ILlmProvider` port rather than calling a model SDK directly, so the deterministic engine stays the source of truth and the model remains an optional, swappable, individually-testable consumer of its output.

## Technology summary

Electron + React + TypeScript + TailwindCSS + Zustand on the front; Node.js + TypeScript on the back; `mysql2` and `mongodb` as drivers; `sql.js` (WASM SQLite, no native build) for local storage; `node-sql-parser` for SQL normalization; Recharts for charts; Zod for validating data crossing the IPC boundary. The build uses `electron-vite` for fast dev reload and `electron-builder` for packaging Windows, macOS, and Linux artifacts. Dark mode is the default and only first-class theme, styled after TablePlus, MongoDB Compass, and Datadog.
