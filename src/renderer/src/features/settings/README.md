# settings

Per-connection monitoring settings: slow-query threshold, poll interval,
history retention, and auto-explain.

Loads the active connection's `MonitoringSettings` via
`api.monitoring.getSettings`, validates edits client-side (whole numbers within
sane bounds), and persists with `api.monitoring.saveSettings`. Changes apply
the next time monitoring starts for the connection. "Reset to defaults" restores
the same defaults the backend falls back to when a connection has no saved row.
