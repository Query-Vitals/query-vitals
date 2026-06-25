/**
 * Per-connection monitoring settings: slow-query threshold, poll interval,
 * history retention, and auto-explain. Loads the active connection's settings
 * from the backend, validates edits client-side, and persists via
 * `api.monitoring.saveSettings`.
 */

import { useEffect, useMemo, useState } from 'react';
import type { MonitoringSettings } from '@shared/types/metrics';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  ErrorBanner,
  Input,
  Loading,
  Switch,
} from '@renderer/shared/ui';
import { getApi, useApi, useMutation } from '@renderer/shared/hooks/useApi';
import { useAppStore } from '@renderer/shared/store/app-store';

/**
 * UI-side mirror of the backend defaults (see persistence/schema.ts). Kept
 * local because the renderer must not import from the main process; used only
 * for the "Reset to defaults" affordance.
 */
const DEFAULTS: MonitoringSettings = {
  slowQueryThresholdMs: 100,
  pollIntervalMs: 5000,
  historyRetentionLimit: 5000,
  autoExplain: true,
};

interface FieldSpec {
  key: keyof Pick<
    MonitoringSettings,
    'slowQueryThresholdMs' | 'pollIntervalMs' | 'historyRetentionLimit'
  >;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
}

const NUMERIC_FIELDS: FieldSpec[] = [
  {
    key: 'slowQueryThresholdMs',
    label: 'Slow query threshold (ms)',
    hint: 'Queries with an average time at or above this are flagged "slow".',
    min: 1,
    max: 600_000,
    step: 10,
  },
  {
    key: 'pollIntervalMs',
    label: 'Poll interval (ms)',
    hint: 'How often the collector samples the database for new queries.',
    min: 1000,
    max: 600_000,
    step: 500,
  },
  {
    key: 'historyRetentionLimit',
    label: 'History retention (records)',
    hint: 'Oldest query records beyond this count are pruned per connection.',
    min: 100,
    max: 1_000_000,
    step: 100,
  },
];

function validate(s: MonitoringSettings): Partial<Record<keyof MonitoringSettings, string>> {
  const errors: Partial<Record<keyof MonitoringSettings, string>> = {};
  for (const f of NUMERIC_FIELDS) {
    const v = s[f.key];
    if (!Number.isFinite(v) || !Number.isInteger(v)) {
      errors[f.key] = 'Enter a whole number.';
    } else if (v < f.min || v > f.max) {
      errors[f.key] = `Must be between ${f.min.toLocaleString()} and ${f.max.toLocaleString()}.`;
    }
  }
  return errors;
}

function equal(a: MonitoringSettings, b: MonitoringSettings): boolean {
  return (
    a.slowQueryThresholdMs === b.slowQueryThresholdMs &&
    a.pollIntervalMs === b.pollIntervalMs &&
    a.historyRetentionLimit === b.historyRetentionLimit &&
    a.autoExplain === b.autoExplain
  );
}

export default function SettingsScreen(): JSX.Element {
  const activeConnectionId = useAppStore((s) => s.activeConnectionId);
  const connections = useAppStore((s) => s.connections);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const active = connections.find((c) => c.id === activeConnectionId);
  const cid = activeConnectionId ?? '';

  const loaded = useApi<MonitoringSettings | undefined>(
    async () => {
      const api = getApi();
      if (!api || !cid) return undefined;
      return api.monitoring.getSettings(cid);
    },
    [cid],
    { enabled: !!cid },
  );

  // Local editable copy of the loaded settings.
  const [draft, setDraft] = useState<MonitoringSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const save = useMutation();

  // Sync the draft when fresh settings arrive (connection change / reload).
  useEffect(() => {
    if (loaded.data) setDraft({ ...loaded.data });
  }, [loaded.data]);

  const errors = useMemo(() => (draft ? validate(draft) : {}), [draft]);
  const hasErrors = Object.keys(errors).length > 0;
  const dirty = useMemo(
    () => (draft && loaded.data ? !equal(draft, loaded.data) : false),
    [draft, loaded.data],
  );

  const setField = (key: keyof MonitoringSettings, value: number | boolean): void => {
    setSaved(false);
    setDraft((prev) => (prev ? { ...prev, [key]: value } : prev));
  };

  const onSave = async (): Promise<void> => {
    const api = getApi();
    if (!api || !draft || hasErrors) return;
    const ok = await save.run(async () => {
      await api.monitoring.saveSettings(cid, draft);
      return true;
    });
    if (ok) {
      setSaved(true);
      loaded.setData(draft);
    }
  };

  const onReset = (): void => {
    setSaved(false);
    setDraft({ ...DEFAULTS });
  };

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-100">Settings</h1>
        <p className="text-xs text-slate-400">Appearance and per-connection monitoring.</p>
      </div>

      <Card>
        <CardHeader title="Appearance" subtitle="Choose how the interface is rendered." />
        <CardBody>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-slate-200">Liquid Glass</div>
              <div className="text-xs text-slate-500">
                macOS 26 translucent material with depth and blur. Turn off for the classic
                opaque dark theme.
              </div>
            </div>
            <Switch
              checked={theme === 'glass'}
              onChange={(on) => setTheme(on ? 'glass' : 'default')}
              aria-label="Liquid Glass theme"
            />
          </div>
        </CardBody>
      </Card>

      {!activeConnectionId ? (
        <EmptyState
          title="No active connection"
          description="Select a connection from the top bar to edit its monitoring settings."
        />
      ) : loaded.error != null ? (
        <ErrorBanner message={`Failed to load settings: ${loaded.error}`} />
      ) : loaded.loading || !draft ? (
        <Loading label="Loading settings…" />
      ) : (
        <Card>
          <CardHeader
            title="Monitoring"
            subtitle="Applied the next time monitoring starts for this connection."
          />
          <CardBody className="space-y-4">
            {NUMERIC_FIELDS.map((f) => (
              <Input
                key={f.key}
                type="number"
                label={f.label}
                hint={f.hint}
                min={f.min}
                max={f.max}
                step={f.step}
                value={Number.isFinite(draft[f.key]) ? String(draft[f.key]) : ''}
                onChange={(e) => setField(f.key, e.target.valueAsNumber)}
                {...(errors[f.key] ? { error: errors[f.key] } : {})}
              />
            ))}

            <label className="glass-well flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition-colors focus-within:border-accent-muted hover:border-glass-highlight">
              <input
                type="checkbox"
                checked={draft.autoExplain}
                onChange={(e) => setField('autoExplain', e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
              <span>
                <span className="block text-sm font-medium text-slate-200">Auto-explain</span>
                <span className="block text-xs text-slate-500">
                  Automatically run EXPLAIN on newly captured queries to score them and detect
                  index usage. Disable to reduce load on the database.
                </span>
              </span>
            </label>
          </CardBody>
        </Card>
      )}

      {activeConnectionId && (
        <>
          {save.error != null && <ErrorBanner message={`Failed to save: ${save.error}`} />}

          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              onClick={() => void onSave()}
              loading={save.loading}
              disabled={!draft || !dirty || hasErrors}
            >
              Save settings
            </Button>
            <Button variant="ghost" onClick={onReset} disabled={!draft}>
              Reset to defaults
            </Button>
            {saved && !dirty && <span className="text-xs text-good">Saved.</span>}
            {dirty && !hasErrors && (
              <span className="text-xs text-slate-500">Unsaved changes</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
