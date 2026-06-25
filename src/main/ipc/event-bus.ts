/**
 * Pushes main → renderer events to all open windows. Services depend on this
 * thin interface rather than on Electron's webContents directly.
 */

import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/contracts/ipc';
import type { QueryRecord } from '@shared/types/query';

export interface IEventBus {
  emitQueriesCaptured(records: QueryRecord[]): void;
  emitConnectionStatus(connectionId: string, status: string): void;
  emitMonitoringState(connectionId: string, running: boolean): void;
}

export class EventBus implements IEventBus {
  private targets: WebContents[] = [];

  register(wc: WebContents): void {
    if (!this.targets.includes(wc)) this.targets.push(wc);
    wc.on('destroyed', () => {
      this.targets = this.targets.filter((t) => t !== wc);
    });
  }

  emitQueriesCaptured(records: QueryRecord[]): void {
    this.send(IpcChannels.events.queriesCaptured, records);
  }

  emitConnectionStatus(connectionId: string, status: string): void {
    this.send(IpcChannels.events.connectionStatus, { connectionId, status });
  }

  emitMonitoringState(connectionId: string, running: boolean): void {
    this.send(IpcChannels.events.monitoringState, { connectionId, running });
  }

  private send(channel: string, payload: unknown): void {
    for (const wc of this.targets) {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    }
  }
}
