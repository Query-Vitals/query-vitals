# Contributing

Thanks for helping improve Query Vitals. This project is a local-first desktop tool for database performance analysis, so contributions should preserve three core principles: deterministic analysis first, clear user-facing explanations, and no cloud dependency in the default experience.

## Good first contributions

- Improve empty, loading, and error states.
- Add focused tests for analyzer or recommendation rules.
- Tighten execution-plan parsing for MySQL or MongoDB edge cases.
- Improve documentation, screenshots, or setup guidance.
- Help prepare future PostgreSQL support.

## Development setup

```bash
npm install
npm run dev
npm run typecheck
npm run test
```

Before opening a pull request, run:

```bash
npm run typecheck
npm run test
```

## Architecture expectations

- Keep database-specific behavior inside connector adapters.
- Keep domain and application code free of Electron, database driver, and filesystem imports.
- Store secrets through the secret-store port, not in SQLite or renderer state.
- Prefer pure, focused tests for scoring, analysis, and recommendation behavior.
- Keep AI-related work optional, opt-in, and behind the provider port described in `docs/ROADMAP.md`.

## Pull requests

Please include:

- A short description of the user-visible change.
- Notes about database/version coverage if the change touches connectors.
- Test coverage or a clear reason tests were not added.
- Screenshots for meaningful UI changes.

Small, focused PRs are easiest to review.
