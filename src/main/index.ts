/**
 * Electron main-process entry point: opens the local DB, wires IPC, creates the
 * window, registers it with the event bus, and disposes cleanly on quit.
 */

import { app, BrowserWindow } from 'electron';
import { join } from 'node:path';
import { buildContainer, type AppContainer } from './bootstrap/container';
import { registerIpcHandlers } from './ipc/register-handlers';
import { initAutoUpdater } from './updater';

let container: AppContainer | null = null;

const isMac = process.platform === 'darwin';

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    // macOS 26 "Liquid Glass": a translucent window whose sidebar refracts the
    // desktop wallpaper behind it. The window is transparent and the renderer
    // paints translucent glass surfaces over the native vibrancy material.
    // Other platforms keep an opaque dark background (no transparent window).
    ...(isMac
      ? {
          transparent: true,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
          titleBarStyle: 'hiddenInset' as const,
          roundedCorners: true,
        }
      : { backgroundColor: '#0b0e14' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false, // sql.js + node APIs run in main; preload stays minimal
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  container?.eventBus.register(win.webContents);
  return win;
}

app.whenReady().then(async () => {
  container = await buildContainer(app.getPath('userData'));
  registerIpcHandlers(container);

  const win = createWindow();
  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  initAutoUpdater();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', async (e) => {
  if (container) {
    e.preventDefault();
    const c = container;
    container = null;
    await c.dispose();
    app.quit();
  }
});
