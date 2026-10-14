/**
 * Live alert events from `/ws` topic `alerts` (docs/alerts.md §1.6, §5.1):
 * fires, changed ids and log changes, plus the catch-up after a reconnect.
 */
import type { Alert, AlertLogEntry } from '@investopen/alerts';
import * as alertsApi from '../api/alerts';
import { errorMessage } from '../api/client';
import { getQuoteStream, type EventFrame, type QuoteStream } from '../quotes/stream';
import { mergeLog, useAlerts } from './store';

/** Fires younger than this are announced after a reconnect; older ones only count as unread. */
export const CATCH_UP_ANNOUNCE_MS = 5 * 60_000;

export type FiredAlertInfo = Pick<
  Alert,
  'id' | 'status' | 'revision' | 'fireCount' | 'lastFiredAt'
>;
export type AlertFiredListener = (entry: AlertLogEntry, alert: FiredAlertInfo | null) => void;

const listeners = new Set<AlertFiredListener>();

/** Be told about every fire (live or caught up). Notifications and chart markers use this. */
export function onAlertFired(fn: AlertFiredListener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

function announce(entry: AlertLogEntry, alert: FiredAlertInfo | null): void {
  for (const fn of [...listeners]) {
    try {
      fn(entry, alert);
    } catch (err) {
      console.warn('alert listener failed', err);
    }
  }
}

export interface AlertEventsOptions {
  stream?: Pick<QuoteStream, 'subscribeEvents'>;
  api?: Pick<typeof alertsApi, 'getAlertLog'>;
  now?: () => number;
  /** `alerts.changed`: refetch these ids (deleted ones are already removed from the store). */
  onChanged: (ids: string[]) => void;
  /** The log changed elsewhere (read, cleared, delivery status): refetch the newest page. */
  onLogChanged: () => void;
  /** The socket was down: reload everything that is not the log. */
  onReconnect: () => void;
}

function asEntry(v: unknown): AlertLogEntry | null {
  return v && typeof v === 'object' && typeof (v as AlertLogEntry).id === 'number'
    ? (v as AlertLogEntry)
    : null;
}

/** Subscribe to the `alerts` topic; returns the unsubscribe function. */
export function startAlertEvents(opts: AlertEventsOptions): () => void {
  const stream = opts.stream ?? getQuoteStream();
  const api = opts.api ?? alertsApi;
  const now = opts.now ?? Date.now;

  const onFired = (frame: EventFrame) => {
    const entry = asEntry(frame.entry);
    if (!entry) return;
    const info = (frame.alert as FiredAlertInfo | undefined) ?? null;
    const known = useAlerts.getState().log.some((e) => e.id === entry.id);
    useAlerts.setState((s) => {
      const alerts = { ...s.alerts };
      const cur = info ? alerts[info.id] : undefined;
      if (info && cur) alerts[info.id] = { ...cur, ...info };
      return {
        alerts,
        log: mergeLog(s.log, [entry]),
        unread: !known && !entry.read ? s.unread + 1 : s.unread,
      };
    });
    if (!known) announce(entry, info);
  };

  const onLog = (frame: EventFrame) => {
    if (frame.cleared === true) {
      const alertId = typeof frame.alertId === 'string' ? frame.alertId : null;
      useAlerts.setState((s) => {
        return { log: alertId ? s.log.filter((e) => e.alertId !== alertId) : [] };
      });
    } else if (typeof frame.readUpTo === 'number') {
      const upTo = frame.readUpTo;
      useAlerts.setState((s) => ({
        log: s.log.map((e) => (e.id <= upTo ? { ...e, read: true } : e)),
      }));
    }
    opts.onLogChanged(); // also refreshes the unread total
  };

  const catchUp = async () => {
    const st = useAlerts.getState();
    if (st.status !== 'ready') return; // the initial load covers it
    try {
      const page = await api.getAlertLog({ after: st.log[0]?.id ?? 0, limit: 500 });
      const known = new Set(useAlerts.getState().log.map((e) => e.id));
      const fresh = page.entries.filter((e) => !known.has(e.id));
      useAlerts.setState((s) => ({
        log: mergeLog(s.log, fresh),
        unread: page.unread,
      }));
      const cutoff = now() - CATCH_UP_ANNOUNCE_MS;
      // Oldest first, like they happened.
      for (const e of [...fresh].reverse()) {
        const at = Date.parse(e.firedAt);
        if (!e.read && Number.isFinite(at) && at >= cutoff) announce(e, null);
      }
    } catch (err) {
      console.warn('alerts: catch-up failed', errorMessage(err));
    }
  };

  return stream.subscribeEvents(['alerts'], {
    onFrame: (frame) => {
      if (frame.type === 'alerts.changed') {
        const deleted = Array.isArray(frame.deleted) ? (frame.deleted as string[]) : [];
        const ids = Array.isArray(frame.ids) ? (frame.ids as string[]) : [];
        if (deleted.length)
          useAlerts.setState((s) => {
            const alerts = { ...s.alerts };
            for (const id of deleted) delete alerts[id];
            return { alerts };
          });
        opts.onChanged(ids.filter((id) => !deleted.includes(id)));
      } else if (frame.type === 'alert.fired') onFired(frame);
      else if (frame.type === 'alerts.log') onLog(frame);
    },
    onOpen: (reconnected) => {
      if (!reconnected) return;
      opts.onReconnect();
      void catchUp();
    },
  });
}
