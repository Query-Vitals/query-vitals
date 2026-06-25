/**
 * Registers ipcMain handlers that map IpcChannels → application services.
 * Each handler is a thin adapter: validate-ish, delegate, return serializable.
 */

import { ipcMain } from 'electron';
import { IpcChannels } from '@shared/contracts/ipc';
import type { AppContainer } from '@main/bootstrap/container';
import {
  bucketMsSchema,
  dashboardLimitSchema,
  optionalPasswordSchema,
  parseConnectionConfig,
  parseDashboardRanking,
  parseId,
  parseIsoDate,
  parseMonitoringSettings,
  parseQueryHistoryFilter,
  rawQuerySchema,
} from './validation';

export function registerIpcHandlers(c: AppContainer): void {
  const C = IpcChannels;

  // --- connections ---
  ipcMain.handle(C.connections.list, () => c.connectionService.list());
  ipcMain.handle(C.connections.test, (_e, config: unknown, password?: unknown) =>
    c.connectionService.test(
      parseConnectionConfig(config),
      optionalPasswordSchema.parse(password) ?? null,
    ),
  );
  ipcMain.handle(C.connections.capabilities, (_e, connectionId: unknown) =>
    c.connectionService.capabilities(parseId(connectionId)),
  );
  ipcMain.handle(C.connections.save, (_e, config: unknown, password?: unknown) =>
    c.connectionService.save(parseConnectionConfig(config), optionalPasswordSchema.parse(password)),
  );
  ipcMain.handle(C.connections.delete, async (_e, id: unknown) => {
    const connectionId = parseId(id);
    await c.monitoringService.stop(connectionId).catch(() => undefined);
    return c.connectionService.delete(connectionId);
  });

  // --- monitoring ---
  ipcMain.handle(C.monitoring.start, (_e, id: unknown) =>
    c.monitoringService.start(parseId(id)),
  );
  ipcMain.handle(C.monitoring.stop, (_e, id: unknown) => c.monitoringService.stop(parseId(id)));
  ipcMain.handle(C.monitoring.status, (_e, id: unknown) =>
    c.monitoringService.isRunning(parseId(id)),
  );
  ipcMain.handle(C.monitoring.getSettings, (_e, id: unknown) =>
    c.monitoringService.getSettings(parseId(id)),
  );
  ipcMain.handle(C.monitoring.saveSettings, (_e, id: unknown, s: unknown) =>
    c.monitoringService.saveSettings(parseId(id), parseMonitoringSettings(s)),
  );

  // --- queries ---
  ipcMain.handle(C.queries.list, (_e, filter: unknown) =>
    c.queryRepo.query(parseQueryHistoryFilter(filter)),
  );
  ipcMain.handle(C.queries.get, (_e, id: unknown) => c.queryRepo.get(parseId(id)));
  ipcMain.handle(C.queries.explain, (_e, connectionId: unknown, rawQuery: unknown) =>
    c.analysisService.explain(parseId(connectionId), rawQuerySchema.parse(rawQuery)),
  );

  // --- dashboard ---
  ipcMain.handle(C.dashboard.metrics, (_e, id: unknown, from: unknown, to: unknown) =>
    c.queryRepo.metrics(parseId(id), parseIsoDate(from), parseIsoDate(to)),
  );
  ipcMain.handle(C.dashboard.ranking, (_e, id: unknown, ranking: unknown, limit: unknown) =>
    c.queryRepo.ranking(
      parseId(id),
      parseDashboardRanking(ranking),
      dashboardLimitSchema.parse(limit),
    ),
  );
  ipcMain.handle(
    C.dashboard.timeSeries,
    (_e, id: unknown, from: unknown, to: unknown, bucketMs: unknown) =>
      c.queryRepo.timeSeries(
        parseId(id),
        parseIsoDate(from),
        parseIsoDate(to),
        bucketMsSchema.parse(bucketMs),
      ),
  );

  // --- recommendations ---
  ipcMain.handle(C.recommendations.list, (_e, id: unknown) =>
    c.recommendationService.list(parseId(id)),
  );
  ipcMain.handle(C.recommendations.dismiss, (_e, id: unknown) =>
    c.recommendationService.dismiss(parseId(id)),
  );

  // --- workload insights ---
  ipcMain.handle(C.workload.list, (_e, id: unknown) => c.workloadService.list(parseId(id)));
}
