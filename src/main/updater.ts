/**
 * Auto-update wiring (electron-updater).
 *
 * The publish target in electron-builder.yml is a PLACEHOLDER generic feed.
 * Until it points at a real update server or GitHub release, update checks
 * cannot reach a feed — by design this degrades gracefully: every failure is
 * logged and swallowed, never blocking startup or surfacing an error to the
 * user. When a real feed is configured, nothing here needs to change.
 *
 * Checks run only in the packaged app (electron-updater cannot update an
 * unpackaged dev tree) and can be disabled with INDEX_MONITOR_DISABLE_UPDATES=1.
 */

import { app } from 'electron';
// electron-updater is CommonJS; the default import + destructure is the
// documented interop for ESM main processes.
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

// Re-check roughly every six hours while the app stays open.
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export function initAutoUpdater(): void {
  if (!app.isPackaged) return; // dev tree can't be updated
  if (process.env['INDEX_MONITOR_DISABLE_UPDATES'] === '1') return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    // A missing/placeholder feed lands here. Stay quiet until a real update
    // server exists — an unreachable feed is expected, not a user-facing fault.
    console.warn('[updater] check failed:', err instanceof Error ? err.message : err);
  });
  autoUpdater.on('update-available', (info) => {
    console.info('[updater] update available:', info.version);
  });
  autoUpdater.on('update-not-available', () => {
    console.info('[updater] up to date');
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.info('[updater] downloaded %s — will install on quit', info.version);
  });

  void check();
  setInterval(check, RECHECK_INTERVAL_MS).unref();
}

function check(): void {
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn('[updater] checkForUpdates rejected:', err instanceof Error ? err.message : err);
  });
}
