# Security Policy

Query Vitals is designed as a local-first desktop application. Query history and recommendations are stored locally, and database passwords are stored through the operating system keychain rather than in SQLite.

## Reporting a vulnerability

Please do not open a public issue for security-sensitive reports.

Until a dedicated security email is published, report vulnerabilities by opening a private GitHub security advisory if the repository supports it. Include:

- Affected version or commit.
- Steps to reproduce.
- Impact and any known workarounds.
- Whether credentials, query text, or local files can be exposed.

## Security boundaries

- The renderer process should not receive direct database, filesystem, or keychain access.
- IPC payloads should be validated before crossing trust boundaries.
- Secrets must go through the secret-store abstraction.
- Optional AI features must remain disabled by default and disclose what data leaves the machine.

## Supported versions

The project is pre-1.0. Security fixes target the latest `main` branch until stable releases are published.
