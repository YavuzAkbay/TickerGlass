/** Alerts, the notification log and service status (docs/alerts.md §5.1). Not persisted: the API is the source. */
import type { Alert, AlertLogEntry } from '@tickerglass/alerts';
import { create } from 'zustand';
import type { AlertChannels, ServiceStatus } from '../api/alerts';
import { useUiStore } from '../store/ui';

export type AlertsStatus = 'idle' | 'loading' | 'ready' | 'offline';
export type PanelTab = 'alerts' | 'log';

interface AlertsState {
  alerts: Record<string, Alert>;
  /** Newest page first (older pages are appended by "load more"). */
  log: AlertLogEntry[];
  logHasMore: boolean;
  unread: number;
  service: ServiceStatus | null;
  channels: AlertChannels | null;
  status: AlertsStatus;
  error: string | null;
  /** Panel state, here so `openAlertLog` works from anywhere. */
  tab: PanelTab;
  /** Log entry to scroll to / highlight. */
  focusEntry: number | null;
}

export const useAlerts = create<AlertsState>()(() => ({
  alerts: {},
  log: [],
  logHasMore: false,
  unread: 0,
  service: null,
  channels: null,
  status: 'idle',
  error: null,
  tab: 'alerts',
  focusEntry: null,
}));

/** Show the Alerts panel on its Log tab, optionally pointing at one entry. */
export function openAlertLog(entryId?: number): void {
  useAlerts.setState({ tab: 'log', focusEntry: entryId ?? null });
  useUiStore.getState().showNav('alerts');
}

/** Insert or replace by id, newest first, no duplicates. */
export function mergeLog(log: AlertLogEntry[], incoming: AlertLogEntry[]): AlertLogEntry[] {
  const byId = new Map(log.map((e) => [e.id, e]));
  for (const e of incoming) byId.set(e.id, e);
  return [...byId.values()].sort((a, b) => b.id - a.id);
}
