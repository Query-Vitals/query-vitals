import { useState } from 'react';
import type { ConnectionConfig } from '@shared/types/database';
import {
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  ErrorBanner,
  Loading,
  StatusDot,
} from '@renderer/shared/ui';
import { getApi, useApi, useMutation } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';
import { formatTimestamp } from '@renderer/shared/lib/format';
import { ConnectionForm } from './ConnectionForm';
import { tagChipStyle } from './labels';

interface ConnectionsScreenProps {
  variant?: 'page' | 'popup';
}

export default function ConnectionsScreen({ variant = 'page' }: ConnectionsScreenProps): JSX.Element {
  const setConnections = useAppStore((s) => s.setConnections);
  const connections = useAppStore((s) => s.connections);
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const setActiveConnection = useAppStore((s) => s.setActiveConnection);
  const statusMap = useAppStore((s) => s.connectionStatus);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ConnectionConfig | undefined>(undefined);
  const del = useMutation();

  const { loading, error, reload } = useApi(
    async () => {
      const api = getApi();
      const list = api ? await api.connections.list() : [];
      setConnections(list);
      return list;
    },
    [],
  );

  const openNew = (): void => {
    setEditing(undefined);
    setFormOpen(true);
  };
  const openEdit = (c: ConnectionConfig): void => {
    setEditing(c);
    setFormOpen(true);
  };

  const onDelete = async (c: ConnectionConfig): Promise<void> => {
    const api = getApi();
    if (!api) return;
    await del.run(() => api.connections.delete(c.id));
    reload();
  };

  const isPopup = variant === 'popup';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        {!isPopup && (
          <div>
            <h1 className="text-lg font-semibold text-slate-100">Connections</h1>
            <p className="text-xs text-slate-400">Manage the databases Query Vitals watches.</p>
          </div>
        )}
        {isPopup && (
          <p className="text-xs text-slate-400">
            Choose the active database or edit saved connection details.
          </p>
        )}
        <Button variant="primary" onClick={openNew}>
          + New connection
        </Button>
      </div>

      {error != null && <ErrorBanner message={`Failed to load connections: ${error}`} />}

      {loading ? (
        <Loading />
      ) : connections.length === 0 ? (
        <EmptyState
          title="No connections yet"
          description="Add a MySQL or MongoDB connection to start monitoring index usage."
          action={
            <Button variant="primary" onClick={openNew}>
              + New connection
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {connections.map((c) => {
            const isActive = c.id === activeConnectionId;
            return (
              <Card
                key={c.id}
                className={isActive ? 'border-accent-muted' : ''}
                style={c.color ? { borderLeftColor: c.color, borderLeftWidth: 3 } : undefined}
              >
                <CardBody className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        {c.color && (
                          <span
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: c.color }}
                            aria-hidden
                          />
                        )}
                        <span className="font-semibold text-slate-100">{c.name}</span>
                        {isActive && <Badge variant="accent">Active</Badge>}
                      </div>
                      <div className="mt-0.5 font-mono text-xs text-slate-400">
                        {c.host}:{c.port}
                        {c.database ? ` / ${c.database}` : ''}
                      </div>
                    </div>
                    <Badge variant={c.engine === 'mysql' ? 'accent' : 'good'}>
                      {c.engine === 'mysql' ? 'MySQL' : 'MongoDB'}
                    </Badge>
                  </div>

                  {c.tags && c.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {c.tags.map((tag) => (
                        <span
                          key={tag}
                          className="inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium"
                          style={tagChipStyle(c.color || undefined)}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center justify-between text-xs text-slate-400">
                    <StatusDot status={statusMap[c.id] ?? 'disconnected'} label />
                    <span>Updated {formatTimestamp(c.updatedAt)}</span>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <Button
                      size="sm"
                      variant={isActive ? 'secondary' : 'primary'}
                      onClick={() => setActiveConnection(c.id)}
                      disabled={isActive}
                    >
                      {isActive ? 'Selected' : 'Select'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => openEdit(c)}>
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => void onDelete(c)}
                      loading={del.loading}
                    >
                      Delete
                    </Button>
                  </div>
                </CardBody>
              </Card>
            );
          })}
        </div>
      )}

      {formOpen && (
        <ConnectionForm
          open={formOpen}
          initial={editing}
          onClose={() => setFormOpen(false)}
          onSaved={() => reload()}
        />
      )}
    </div>
  );
}
