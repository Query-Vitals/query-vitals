import { useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type {
  ConnectionConfig,
  ConnectionTestResult,
  DatabaseEngine,
} from '@shared/types/database';
import { Button, ErrorBanner, Input, Modal, Select } from '@renderer/shared/ui';
import { getApi, useMutation } from '@renderer/shared/hooks/useApi';
import {
  CONNECTION_COLORS,
  SUGGESTED_TAGS,
  normalizeTags,
  tagChipStyle,
} from './labels';
import { PreflightChecklist } from './PreflightChecklist';

interface ConnectionFormProps {
  open: boolean;
  /** Existing connection when editing; undefined when creating. */
  initial?: ConnectionConfig | undefined;
  onClose: () => void;
  onSaved: (config: ConnectionConfig) => void;
}

interface FormState {
  name: string;
  engine: DatabaseEngine;
  host: string;
  port: string;
  username: string;
  password: string;
  database: string;
  authSource: string;
  replicaSet: string;
  notes: string;
  tags: string[];
  color: string;
}

const DEFAULT_PORTS: Record<DatabaseEngine, number> = { mysql: 3306, mongodb: 27017 };

function toFormState(c?: ConnectionConfig): FormState {
  return {
    name: c?.name ?? '',
    engine: c?.engine ?? 'mysql',
    host: c?.host ?? 'localhost',
    port: String(c?.port ?? DEFAULT_PORTS.mysql),
    username: c?.username ?? '',
    password: '',
    database: c?.database ?? '',
    authSource: c?.engine === 'mongodb' ? (c.authSource ?? '') : '',
    replicaSet: c?.engine === 'mongodb' ? (c.replicaSet ?? '') : '',
    notes: c?.notes ?? '',
    tags: c?.tags ?? [],
    color: c?.color ?? '',
  };
}

function buildConfig(initial: ConnectionConfig | undefined, f: FormState): ConnectionConfig {
  const now = new Date().toISOString();
  const base = {
    id: initial?.id ?? crypto.randomUUID(),
    name: f.name.trim() || 'Untitled connection',
    host: f.host.trim(),
    port: Number(f.port) || DEFAULT_PORTS[f.engine],
    createdAt: initial?.createdAt ?? now,
    updatedAt: now,
    ...(f.username.trim() ? { username: f.username.trim() } : {}),
    ...(f.notes.trim() ? { notes: f.notes.trim() } : {}),
    ...(normalizeTags(f.tags).length > 0 ? { tags: normalizeTags(f.tags) } : {}),
    ...(f.color ? { color: f.color } : {}),
    ...(initial?.passwordRef ? { passwordRef: initial.passwordRef } : {}),
  };

  if (f.engine === 'mongodb') {
    return {
      ...base,
      engine: 'mongodb',
      ...(f.database.trim() ? { database: f.database.trim() } : {}),
      ...(f.authSource.trim() ? { authSource: f.authSource.trim() } : {}),
      ...(f.replicaSet.trim() ? { replicaSet: f.replicaSet.trim() } : {}),
    };
  }
  return {
    ...base,
    engine: 'mysql',
    ...(f.database.trim() ? { database: f.database.trim() } : {}),
  };
}

export function ConnectionForm({
  open,
  initial,
  onClose,
  onSaved,
}: ConnectionFormProps): JSX.Element {
  const [form, setForm] = useState<FormState>(() => toFormState(initial));
  const [tagDraft, setTagDraft] = useState('');
  const [testResult, setTestResult] = useState<ConnectionTestResult | undefined>(undefined);
  const test = useMutation();
  const save = useMutation();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTestResult(undefined);
  };

  const addTag = (raw: string): void => {
    const merged = normalizeTags([...form.tags, raw]);
    setForm((prev) => ({ ...prev, tags: merged }));
    setTagDraft('');
  };

  const removeTag = (tag: string): void => {
    setForm((prev) => ({ ...prev, tags: prev.tags.filter((t) => t !== tag) }));
  };

  const onTagKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      if (tagDraft.trim()) addTag(tagDraft);
    } else if (e.key === 'Backspace' && !tagDraft && form.tags.length > 0) {
      removeTag(form.tags[form.tags.length - 1]!);
    }
  };

  const onEngineChange = (engine: string): void => {
    const e = engine as DatabaseEngine;
    setForm((prev) => ({
      ...prev,
      engine: e,
      port: String(DEFAULT_PORTS[e]),
    }));
    setTestResult(undefined);
  };

  const onTest = async (): Promise<void> => {
    const api = getApi();
    if (!api) return;
    const config = buildConfig(initial, form);
    console.log('Testing connection with config', config);
    const result = await test.run(() =>
      api.connections.test(config, form.password ? form.password : undefined),
    );
    if (result) setTestResult(result);
  };

  const onSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const api = getApi();
    if (!api) return;
    const config = buildConfig(initial, form);
    const saved = await save.run(() =>
      api.connections.save(config, form.password ? form.password : undefined),
    );
    if (saved) {
      onSaved(saved);
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Edit connection' : 'New connection'}
      widthClass="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={() => void onTest()}
            loading={test.loading}
          >
            Test connection
          </Button>
          <Button variant="primary" type="submit" form="connection-form" loading={save.loading}>
            Save
          </Button>
        </>
      }
    >
      <form id="connection-form" onSubmit={(e) => void onSubmit(e)} className="space-y-3">
        <Input
          label="Name"
          value={form.name}
          onChange={(e) => set('name', e.target.value)}
          placeholder="Production MySQL"
          autoFocus
        />
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Engine"
            value={form.engine}
            onChange={(e) => onEngineChange(e.target.value)}
            options={[
              { value: 'mysql', label: 'MySQL' },
              { value: 'mongodb', label: 'MongoDB' },
            ]}
          />
          <Input
            label="Port"
            type="number"
            value={form.port}
            onChange={(e) => set('port', e.target.value)}
          />
        </div>
        <Input
          label="Host"
          value={form.host}
          onChange={(e) => set('host', e.target.value)}
          placeholder="localhost"
        />
        <div className="grid grid-cols-2 gap-3">
          <Input
            label="Username"
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
            placeholder="root"
          />
          <Input
            label="Password"
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            placeholder={initial?.passwordRef ? '•••••••• (saved)' : ''}
          />
        </div>
        <Input
          label="Database"
          value={form.database}
          onChange={(e) => set('database', e.target.value)}
          placeholder={form.engine === 'mongodb' ? 'admin' : 'app_db'}
        />
        {form.engine === 'mongodb' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Auth source"
              value={form.authSource}
              onChange={(e) => set('authSource', e.target.value)}
              placeholder="admin"
            />
            <Input
              label="Replica set"
              value={form.replicaSet}
              onChange={(e) => set('replicaSet', e.target.value)}
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-300">Tags</label>
          <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-base-600 bg-base-800 px-2 py-1.5">
            {form.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium"
                style={tagChipStyle(form.color || undefined)}
              >
                {tag}
                <button
                  type="button"
                  onClick={() => removeTag(tag)}
                  className="text-current opacity-70 hover:opacity-100"
                  aria-label={`Remove ${tag}`}
                >
                  ×
                </button>
              </span>
            ))}
            <input
              value={tagDraft}
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={onTagKeyDown}
              onBlur={() => tagDraft.trim() && addTag(tagDraft)}
              placeholder={form.tags.length === 0 ? 'e.g. production, staging…' : ''}
              className="min-w-[8rem] flex-1 bg-transparent text-sm text-slate-100 outline-none placeholder:text-slate-500"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTED_TAGS.filter((t) => !form.tags.includes(t)).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => addTag(t)}
                className="rounded border border-base-600 px-1.5 py-0.5 text-xs text-slate-400 hover:border-accent-muted hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                + {t}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <label className="block text-xs font-medium text-slate-300">Color</label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => set('color', '')}
              className={`flex h-6 w-6 items-center justify-center rounded-full border text-xs text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base-800 ${
                form.color === '' ? 'border-slate-200' : 'border-base-600'
              }`}
              title="No color"
              aria-label="No color"
            >
              ✕
            </button>
            {CONNECTION_COLORS.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => set('color', c.hex)}
                className={`h-6 w-6 rounded-full border-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-base-800 ${
                  form.color === c.hex ? 'border-slate-100' : 'border-transparent'
                }`}
                style={{ backgroundColor: c.hex }}
                title={c.label}
                aria-label={c.label}
              />
            ))}
          </div>
        </div>

        {test.error != null && <ErrorBanner message={test.error} />}
        {testResult != null && (
          <div className="rounded-md border border-base-700 bg-base-800/40 px-3 py-2.5">
            <PreflightChecklist
              result={testResult}
              context={{
                username: form.username,
                host: form.host,
                database: form.database,
              }}
            />
          </div>
        )}
        {save.error != null && <ErrorBanner message={`Save failed: ${save.error}`} />}
      </form>
    </Modal>
  );
}

export default ConnectionForm;
