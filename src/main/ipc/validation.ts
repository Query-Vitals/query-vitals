import { z } from 'zod';
import type { ConnectionConfig } from '@shared/types/database';
import type { DashboardRanking, MonitoringSettings } from '@shared/types/metrics';
import type { QueryHistoryFilter } from '@main/domain/repositories';

const idSchema = z.string().trim().min(1).max(200);
const isoDateSchema = z.string().datetime();
const optionalTextSchema = z.string().trim().max(2000).optional();

const tlsSchema = z
  .object({
    enabled: z.boolean(),
    rejectUnauthorized: z.boolean().optional(),
    caCertPath: z.string().trim().max(2000).optional(),
    clientCertPath: z.string().trim().max(2000).optional(),
    clientKeyPath: z.string().trim().max(2000).optional(),
  })
  .strict();

const baseConnectionSchema = {
  id: idSchema,
  name: z.string().trim().min(1).max(200),
  host: z.string().trim().min(1).max(500),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().max(500).optional(),
  passwordRef: z.string().trim().max(500).optional(),
  database: z.string().trim().max(500).optional(),
  tls: tlsSchema.optional(),
  notes: optionalTextSchema,
  tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
  createdAt: isoDateSchema,
  updatedAt: isoDateSchema,
};

export const connectionConfigSchema = z.discriminatedUnion('engine', [
  z
    .object({
      ...baseConnectionSchema,
      engine: z.literal('mysql'),
    })
    .strict(),
  z
    .object({
      ...baseConnectionSchema,
      engine: z.literal('mongodb'),
      authSource: z.string().trim().max(500).optional(),
      replicaSet: z.string().trim().max(500).optional(),
    })
    .strict(),
]);

export const optionalPasswordSchema = z.string().max(10_000).optional();

export const monitoringSettingsSchema = z
  .object({
    slowQueryThresholdMs: z.number().int().min(0).max(600_000),
    pollIntervalMs: z.number().int().min(500).max(3_600_000),
    historyRetentionLimit: z.number().int().min(100).max(100_000),
    autoExplain: z.boolean(),
  })
  .strict();

export const queryHistoryFilterSchema = z
  .object({
    connectionId: idSchema,
    from: isoDateSchema.optional(),
    to: isoDateSchema.optional(),
    onlyFullScans: z.boolean().optional(),
    onlyNonIndexed: z.boolean().optional(),
    minExecutionTimeMs: z.number().min(0).max(600_000).optional(),
    search: z.string().trim().max(500).optional(),
    limit: z.number().int().min(1).max(1_000).optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

export const dashboardRankingSchema = z.enum([
  'slowest',
  'most-executed',
  'full-scans',
  'poor-selectivity',
]);

export const dashboardLimitSchema = z.number().int().min(1).max(100);
export const bucketMsSchema = z.number().int().min(1_000).max(86_400_000);
export const rawQuerySchema = z.string().trim().min(1).max(100_000);

export function parseConnectionConfig(value: unknown): ConnectionConfig {
  return connectionConfigSchema.parse(value) as ConnectionConfig;
}

export function parseMonitoringSettings(value: unknown): MonitoringSettings {
  return monitoringSettingsSchema.parse(value) as MonitoringSettings;
}

export function parseQueryHistoryFilter(value: unknown): QueryHistoryFilter {
  return queryHistoryFilterSchema.parse(value) as QueryHistoryFilter;
}

export function parseDashboardRanking(value: unknown): DashboardRanking {
  return dashboardRankingSchema.parse(value) as DashboardRanking;
}

export function parseId(value: unknown): string {
  return idSchema.parse(value);
}

export function parseIsoDate(value: unknown): string {
  return isoDateSchema.parse(value);
}
