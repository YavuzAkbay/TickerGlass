/** Typed calls for the alert endpoints (docs/alerts.md §1.4). */
import type { Alert, AlertIn, AlertLogEntry, AlertStatus, DeliveryChannel } from '@investopen/alerts';
import { ApiError, requestJson, type RequestOptions } from './client';

type Opts = Pick<RequestOptions, 'signal'>;
const seg = encodeURIComponent;

export interface AlertLogPage {
  entries: AlertLogEntry[];
  hasMore: boolean;
  /** Total unread count (not just this page). */
  unread: number;
}

export interface AlertLogQuery {
  alertId?: string;
  symbol?: string;
  before?: number;
  after?: number;
  limit?: number;
}

export interface AlertChannels {
  webhook: { configured: boolean; url: string | null };
  telegram: { configured: boolean };
  email: { configured: boolean; to: string | null };
}

/** `GET /alerts/service`: `{online:false}` before any heartbeat. */
export interface ServiceStatus {
  online: boolean;
  lastHeartbeatAt?: string;
  version?: string;
  startedAt?: string;
  series?: number;
  liveSymbols?: number;
  polledSeries?: number;
  lastError?: string | null;
}

export type AlertUpdate = AlertIn & { revision?: number };
export interface AlertPatch {
  status: 'active' | 'paused';
  expiresAt?: string | null;
  revision?: number;
}

export const listAlerts = (q: { status?: AlertStatus; symbol?: string } = {}, o?: Opts) =>
  requestJson<Alert[]>('GET', '/alerts', undefined, { ...o, query: q });
export const getAlert = (id: string, o?: Opts) =>
  requestJson<Alert>('GET', `/alerts/${seg(id)}`, undefined, o);
/** With an existing `id`, rejects with 409 (see `alertConflict`). */
export const createAlert = (body: AlertIn, o?: Opts) =>
  requestJson<Alert>('POST', '/alerts', body, o);
/** With a stale `revision`, rejects with 409; without one it overwrites. */
export const updateAlert = (id: string, body: AlertUpdate, o?: Opts) =>
  requestJson<Alert>('PUT', `/alerts/${seg(id)}`, body, o);
export const patchAlert = (id: string, body: AlertPatch, o?: Opts) =>
  requestJson<Alert>('PATCH', `/alerts/${seg(id)}`, body, o);
export const deleteAlert = (id: string, o?: Opts) =>
  requestJson<void>('DELETE', `/alerts/${seg(id)}`, undefined, o);

export const getAlertLog = (q: AlertLogQuery = {}, o?: Opts) =>
  requestJson<AlertLogPage>('GET', '/alerts/log', undefined, { ...o, query: { ...q } });
export const markAlertLogRead = (body: { upTo?: number; ids?: number[] }, o?: Opts) =>
  requestJson<{ unread: number }>('POST', '/alerts/log/read', body, o);
export const clearAlertLog = (alertId?: string, o?: Opts) =>
  requestJson<void>('DELETE', '/alerts/log', undefined, {
    ...o,
    query: { alertId },
  });

export const getAlertChannels = (o?: Opts) =>
  requestJson<AlertChannels>('GET', '/alerts/channels', undefined, o);
export const testAlertChannel = (channel: DeliveryChannel, webhookUrl?: string, o?: Opts) =>
  requestJson<{ ok: boolean }>(
    'POST',
    `/alerts/channels/${seg(channel)}/test`,
    webhookUrl ? { webhookUrl } : {},
    o,
  );
export const getAlertService = (o?: Opts) =>
  requestJson<ServiceStatus>('GET', '/alerts/service', undefined, o);

/** The stored alert from a create/update/patch 409, else null. */
export function alertConflict(e: unknown): Alert | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = (e.body as { detail?: unknown } | undefined)?.detail;
  const cur = d && typeof d === 'object' ? (d as { current?: unknown }).current : null;
  return cur && typeof cur === 'object' ? (cur as Alert) : null;
}
