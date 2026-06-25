/**
 * Preload bridge. Exposes the full, typed `window.api` to the renderer using
 * contextBridge — the renderer never touches ipcRenderer or Node directly.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IpcChannels, type IpcApi } from '@shared/contracts/ipc';

const C = IpcChannels;
const allowedEventChannels = new Set<string>([
  C.events.queriesCaptured,
  C.events.connectionStatus,
  C.events.monitoringState,
]);

const api: IpcApi = {
  connections: {
    list: () => ipcRenderer.invoke(C.connections.list),
    test: (config, password) => ipcRenderer.invoke(C.connections.test, config, password),
    capabilities: (connectionId) => ipcRenderer.invoke(C.connections.capabilities, connectionId),
    save: (config, password) => ipcRenderer.invoke(C.connections.save, config, password),
    delete: (id) => ipcRenderer.invoke(C.connections.delete, id),
  },
  monitoring: {
    start: (id) => ipcRenderer.invoke(C.monitoring.start, id),
    stop: (id) => ipcRenderer.invoke(C.monitoring.stop, id),
    status: (id) => ipcRenderer.invoke(C.monitoring.status, id),
    getSettings: (id) => ipcRenderer.invoke(C.monitoring.getSettings, id),
    saveSettings: (id, s) => ipcRenderer.invoke(C.monitoring.saveSettings, id, s),
  },
  queries: {
    list: (filter) => ipcRenderer.invoke(C.queries.list, filter),
    get: (id) => ipcRenderer.invoke(C.queries.get, id),
    explain: (connectionId, rawQuery) => ipcRenderer.invoke(C.queries.explain, connectionId, rawQuery),
  },
  dashboard: {
    metrics: (id, from, to) => ipcRenderer.invoke(C.dashboard.metrics, id, from, to),
    ranking: (id, ranking, limit) => ipcRenderer.invoke(C.dashboard.ranking, id, ranking, limit),
    timeSeries: (id, from, to, bucketMs) =>
      ipcRenderer.invoke(C.dashboard.timeSeries, id, from, to, bucketMs),
  },
  recommendations: {
    list: (id) => ipcRenderer.invoke(C.recommendations.list, id),
    dismiss: (id) => ipcRenderer.invoke(C.recommendations.dismiss, id),
  },
  workload: {
    list: (id) => ipcRenderer.invoke(C.workload.list, id),
  },
  on: ((channel: string, cb: (...args: never[]) => void) => {
    if (!allowedEventChannels.has(channel)) {
      throw new Error(`Unsupported IPC event channel: ${channel}`);
    }
    const listener = (_e: IpcRendererEvent, ...args: unknown[]): void =>
      (cb as (...a: unknown[]) => void)(...args);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }) as IpcApi['on'],
};

contextBridge.exposeInMainWorld('api', api);
