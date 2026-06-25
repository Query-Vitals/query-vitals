/**
 * Zustand global store (UI state only — server/derived data is fetched via
 * window.api and cached per feature).
 */

import { create } from 'zustand';
import type { ConnectionConfig } from '@shared/types/database';

export type ConnectionStatusMap = Record<string, string>;
export type MonitoringStatusMap = Record<string, boolean>;

/** Visual theme: `glass` = macOS 26 Liquid Glass, `default` = classic opaque dark. */
export type Theme = 'glass' | 'default';

const THEME_KEY = 'qd:theme';

/** Read the persisted theme, defaulting to Liquid Glass. */
function initialTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'default' ? 'default' : 'glass';
  } catch {
    return 'glass';
  }
}

interface AppState {
  activeConnectionId: string | null;
  connections: ConnectionConfig[];
  /** Live connection status keyed by connection id (from push events). */
  connectionStatus: ConnectionStatusMap;
  /**
   * Whether monitoring is running, keyed by connection id. Lives in the store
   * (not in MonitoringScreen) so it survives tab navigation that unmounts the
   * screen, and is the single source of truth synced from the backend.
   */
  monitoringStatus: MonitoringStatusMap;
  /** Active visual theme; persisted to localStorage. */
  theme: Theme;
  setActiveConnection: (id: string | null) => void;
  setConnections: (connections: ConnectionConfig[]) => void;
  setConnectionStatus: (id: string, status: string) => void;
  setMonitoring: (id: string, running: boolean) => void;
  setTheme: (theme: Theme) => void;
}

export const useAppStore = create<AppState>((set) => ({
  activeConnectionId: null,
  connections: [],
  connectionStatus: {},
  monitoringStatus: {},
  theme: initialTheme(),
  setActiveConnection: (id) => set({ activeConnectionId: id }),
  setConnections: (connections) =>
    set((state) => {
      // Auto-select the first connection if none is active yet.
      const activeStillExists =
        state.activeConnectionId != null &&
        connections.some((c) => c.id === state.activeConnectionId);
      const activeConnectionId = activeStillExists
        ? state.activeConnectionId
        : (connections[0]?.id ?? null);
      return { connections, activeConnectionId };
    }),
  setConnectionStatus: (id, status) =>
    set((state) => ({
      connectionStatus: { ...state.connectionStatus, [id]: status },
    })),
  setMonitoring: (id, running) =>
    set((state) => ({
      monitoringStatus: { ...state.monitoringStatus, [id]: running },
    })),
  setTheme: (theme) => {
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode / storage disabled — theme just won't persist */
    }
    set({ theme });
  },
}));
