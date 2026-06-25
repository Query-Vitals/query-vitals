/**
 * Root component: app shell (sidebar + top bar) and HashRouter routes.
 * HashRouter is used because the app loads over file:// in Electron.
 */

import { useEffect, useState } from 'react';
import {
  HashRouter,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from 'react-router-dom';
import { getApi } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';
import { Button, Modal, StatusDot } from '@renderer/shared/ui';
import DashboardScreen from '@renderer/features/dashboard/DashboardScreen';
import ConnectionsScreen from '@renderer/features/connections/ConnectionsScreen';
import MonitoringScreen from '@renderer/features/monitoring/MonitoringScreen';
import SuggestionsScreen from '@renderer/features/suggestions/SuggestionsScreen';
import WorkloadScreen from '@renderer/features/workload/WorkloadScreen';
import QueryDetailScreen from '@renderer/features/query-detail/QueryDetailScreen';
import SettingsScreen from '@renderer/features/settings/SettingsScreen';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: DashboardIcon },
  { to: '/monitoring', label: 'Monitoring', icon: PulseIcon },
  { to: '/suggestions', label: 'Suggestions', icon: BulbIcon },
  { to: '/workload', label: 'Workload', icon: StackIcon },
  { to: '/settings', label: 'Settings', icon: GearIcon },
];

/** Mac gets the native Liquid Glass window (transparent + vibrancy). */
function isMacPlatform(): boolean {
  return navigator.platform.toLowerCase().includes('mac');
}

export function App(): JSX.Element {
  const setConnections = useAppStore((s) => s.setConnections);
  const setConnectionStatus = useAppStore((s) => s.setConnectionStatus);
  const setMonitoring = useAppStore((s) => s.setMonitoring);
  const theme = useAppStore((s) => s.theme);
  const [connectionsOpen, setConnectionsOpen] = useState(false);

  // Flag the document on macOS so the window can go transparent and let the
  // native vibrancy material refract the wallpaper through the glass chrome.
  useEffect(() => {
    if (isMacPlatform()) document.documentElement.classList.add('is-mac');
  }, []);

  // Apply the chosen theme: `default` swaps the Liquid Glass material for the
  // classic opaque dark surfaces (see `.theme-default` in globals.css).
  useEffect(() => {
    document.documentElement.classList.toggle('theme-default', theme === 'default');
  }, [theme]);

  // Load connections on mount.
  useEffect(() => {
    const api = getApi();
    if (!api) return;
    void (async () => {
      try {
        const list = await api.connections.list();
        setConnections(list);
      } catch {
        /* backend may be partial — leave store empty */
      }
    })();
  }, [setConnections]);

  // Subscribe to live connection-status pushes.
  useEffect(() => {
    const api = getApi();
    if (!api?.on) return;
    const unsubscribe = api.on('events:connectionStatus', (p) => {
      setConnectionStatus(p.connectionId, p.status);
    });
    return unsubscribe;
  }, [setConnectionStatus]);

  // Subscribe to monitoring-state pushes. Lives here (always mounted) so the
  // running flag stays correct even while the Monitoring screen is unmounted.
  useEffect(() => {
    const api = getApi();
    if (!api?.on) return;
    const unsubscribe = api.on('events:monitoringState', (p) => {
      setMonitoring(p.connectionId, p.running);
    });
    return unsubscribe;
  }, [setMonitoring]);

  return (
    <HashRouter>
      <KeyboardShortcuts />
      <div className="flex h-screen text-slate-200">
        <Sidebar />
        {/* Content column: a near-opaque dark glass so dense query tables stay
            high-contrast over the wallpaper, per HIG (legibility > translucency). */}
        <div className="flex min-w-0 flex-1 flex-col bg-base-900/80 backdrop-blur-glass-lg">
          <TopBar onManageConnections={() => setConnectionsOpen(true)} />
          <main className="flex-1 overflow-auto p-5">
            <Routes>
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              <Route path="/dashboard" element={<DashboardScreen />} />
              <Route path="/connections" element={<Navigate to="/dashboard" replace />} />
              <Route path="/monitoring" element={<MonitoringScreen />} />
              <Route path="/suggestions" element={<SuggestionsScreen />} />
              <Route path="/workload" element={<WorkloadScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/query/:id" element={<QueryDetailScreen />} />
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </main>
        </div>
        <Modal
          open={connectionsOpen}
          onClose={() => setConnectionsOpen(false)}
          title="Connections"
          widthClass="max-w-5xl"
        >
          <ConnectionsScreen variant="popup" />
        </Modal>
      </div>
    </HashRouter>
  );
}

/** Platform-appropriate modifier symbol for the nav shortcut hints. */
function shortcutPrefix(): string {
  return navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+';
}

/**
 * Global keyboard navigation: ⌘/Ctrl + 1–4 jumps between the primary screens.
 * Ignored while a text field is focused so it never hijacks typing.
 */
function KeyboardShortcuts(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement)?.isContentEditable) {
        return;
      }
      const index = Number(e.key) - 1;
      const target = NAV[index];
      if (target) {
        e.preventDefault();
        navigate(target.to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
  return null;
}

function Sidebar(): JSX.Element {
  return (
    <aside className="glass-chrome flex w-56 flex-col border-r">
      {/* Draggable title-bar zone. Extra top padding clears the overlaid
          macOS traffic-light buttons (titleBarStyle: hiddenInset). */}
      <div className="app-drag flex items-center gap-2 border-b border-glass-border px-4 pb-4 pt-7">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-sm font-bold text-white shadow-glass">
          QV
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-100">Query Vitals</div>
          <div className="text-[10px] uppercase tracking-wider text-slate-500">MySQL · MongoDB</div>
        </div>
      </div>
      <nav className="app-no-drag flex-1 space-y-1 p-2">
        {NAV.map(({ to, label, icon: Icon }, i) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              [
                'group flex items-center gap-2.5 rounded-full px-3 py-2 text-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                isActive
                  ? 'border border-glass-highlight bg-accent/20 text-accent shadow-glass'
                  : 'border border-transparent text-slate-300 hover:bg-white/5 hover:text-slate-100',
              ].join(' ')
            }
          >
            <Icon />
            <span className="flex-1">{label}</span>
            <kbd className="rounded border border-glass-border px-1 text-[10px] leading-tight text-slate-500 opacity-0 transition-opacity group-hover:opacity-100">
              {shortcutPrefix()}
              {i + 1}
            </kbd>
          </NavLink>
        ))}
      </nav>
      <div className="border-t border-glass-border px-4 py-3 text-[10px] text-slate-600">
        v0.2.0
      </div>
    </aside>
  );
}

function TopBar({ onManageConnections }: { onManageConnections: () => void }): JSX.Element {
  const connections = useAppStore((s) => s.connections);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnection = useAppStore((s) => s.setActiveConnection);
  const statusMap = useAppStore((s) => s.connectionStatus);

  const active = connections.find((c) => c.id === activeConnectionId);

  return (
    <header className="app-drag flex h-14 shrink-0 items-center justify-between border-b border-glass-border px-5">
      <div className="text-xs text-slate-500">
        {active ? `${active.engine} · ${active.host}:${active.port}` : 'No connection selected'}
      </div>
      <div className="app-no-drag flex items-center gap-3">
        {active && <StatusDot status={statusMap[active.id] ?? 'disconnected'} label />}
        <label className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Connection</span>
          <select
            value={activeConnectionId ?? ''}
            onChange={(e) => setActiveConnection(e.target.value || null)}
            className="glass-well h-8 rounded-lg px-2 text-sm text-slate-100 focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {connections.length === 0 && <option value="">No connections</option>}
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <Button size="sm" variant="secondary" onClick={onManageConnections}>
          Manage
        </Button>
      </div>
    </header>
  );
}

/* --- Inline icons (no external deps) --- */
function iconBase(children: JSX.Element): JSX.Element {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      {children}
    </svg>
  );
}
function DashboardIcon(): JSX.Element {
  return iconBase(
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </>,
  );
}
function PulseIcon(): JSX.Element {
  return iconBase(<path d="M1 8h3l2-5 4 10 2-5h3" strokeLinecap="round" strokeLinejoin="round" />);
}
function BulbIcon(): JSX.Element {
  return iconBase(
    <>
      <path d="M8 1.5a4 4 0 0 0-2.5 7.1V11h5V8.6A4 4 0 0 0 8 1.5Z" strokeLinejoin="round" />
      <path d="M6 13h4M6.5 14.5h3" strokeLinecap="round" />
    </>,
  );
}
function StackIcon(): JSX.Element {
  return iconBase(
    <>
      <path d="M8 1.5 14.5 5 8 8.5 1.5 5 8 1.5Z" strokeLinejoin="round" />
      <path d="M1.5 8 8 11.5 14.5 8M1.5 11 8 14.5 14.5 11" strokeLinejoin="round" />
    </>,
  );
}
function GearIcon(): JSX.Element {
  return iconBase(
    <>
      <circle cx="8" cy="8" r="2" />
      <path
        d="M8 1.5v1.7M8 12.8v1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M1.5 8h1.7M12.8 8h1.7M3.4 12.6l1.2-1.2M11.4 4.6l1.2-1.2"
        strokeLinecap="round"
      />
    </>,
  );
}

export default App;
