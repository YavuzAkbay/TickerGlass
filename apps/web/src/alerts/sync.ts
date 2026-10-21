/**
 * Alerts <-> `/alerts*` (docs/alerts.md §5.1). The server is the only source
 * of truth (no offline queue): the store is loaded on start, on reconnect, on
 * focus/visible, and refetched by id on `alerts.changed`. Writes carry the
 * revision they are based on; on 409 the stored alert is adopted and a "Keep
 * mine" toast re-sends the change without a revision.
 */
import type { Alert, AlertIn } from '@tickerglass/alerts';
import * as alertsApi from '../api/alerts';
import { ApiError, errorMessage } from '../api/client';
import { commands } from '../commands/registry';
import { useUiStore } from '../store/ui';
import { actionToast, toast } from '../ui/Toast';
import { startAlertEvents } from './events';
import { mergeLog, useAlerts } from './store';

export type AlertsApi = typeof alertsApi;

export const SERVICE_POLL_MS = 60_000;
export const RETRY_MS = 15_000;
export const LOG_PAGE = 100;
/** More changed ids than this: reload the list instead of one GET each. */
const REFETCH_BULK = 10;

export interface AlertsSyncOptions {
  api?: AlertsApi;
  onError?: (message: string) => void;
  /** Writing alert `name` hit a newer server version, now shown; `restore` re-sends mine. */
  onConflict?: (name: string, restore: () => void) => void;
  events?: typeof startAlertEvents;
}

type EditableFields = Omit<AlertIn, 'id'>;

const editable = (a: Alert): EditableFields => ({
  name: a.name,
  symbol: a.symbol,
  interval: a.interval,
  prepost: a.prepost,
  spec: a.spec,
  message: a.message,
  notify: a.notify,
  expiresAt: a.expiresAt,
  ...(a.status === 'active' || a.status === 'paused' ? { status: a.status } : {}),
});

export class AlertsSync {
  private readonly api: AlertsApi;
  private readonly opts: AlertsSyncOptions;
  private stops: (() => void)[] = [];
  private loading: Promise<void> | null = null;

  constructor(opts: AlertsSyncOptions = {}) {
    this.opts = opts;
    this.api = opts.api ?? alertsApi;
  }

  private error(message: string): void {
    (this.opts.onError ?? ((m) => toast(m, 'error', 6000)))(message);
  }

  // ------------------------------------------------------------ lifetime

  start(): void {
    if (this.stops.length) return;
    const stopEvents = (this.opts.events ?? startAlertEvents)({
      onChanged: (ids) => void this.refetch(ids),
      onLogChanged: () => void this.loadLog(),
      onReconnect: () => void this.load(),
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void this.load();
    };
    const onFocus = () => void this.load();
    const dom = typeof document !== 'undefined' && typeof window !== 'undefined';
    if (dom) {
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onFocus);
    }
    const retry = setInterval(() => {
      if (useAlerts.getState().status === 'offline') void this.load();
    }, RETRY_MS);
    const service = setInterval(() => {
      if (
        useUiStore.getState().navOpen &&
        useUiStore.getState().navSection === 'alerts' &&
        (!dom || document.visibilityState === 'visible')
      )
        void this.loadService();
    }, SERVICE_POLL_MS);
    this.stops = [
      stopEvents,
      () => {
        if (!dom) return;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onFocus);
      },
      () => clearInterval(retry),
      () => clearInterval(service),
    ];
    void this.load();
  }

  stop(): void {
    for (const s of this.stops) s();
    this.stops = [];
  }

  // ------------------------------------------------------------ loading

  /** Alerts, newest log page, service and channels. Concurrent calls share one run. */
  load(): Promise<void> {
    this.loading ??= this.loadOnce().finally(() => (this.loading = null));
    return this.loading;
  }

  private async loadOnce(): Promise<void> {
    if (useAlerts.getState().status !== 'ready') useAlerts.setState({ status: 'loading' });
    try {
      const [list, page] = await Promise.all([
        this.api.listAlerts(),
        this.api.getAlertLog({ limit: LOG_PAGE }),
      ]);
      const alerts: Record<string, Alert> = {};
      for (const a of list) alerts[a.id] = a;
      useAlerts.setState((s) => ({
        alerts,
        // Keep older pages already loaded, and fires that arrived since the GET.
        log: mergeLog(
          page.entries.length
            ? s.log.filter((e) => e.id < page.entries.at(-1)!.id || e.id > page.entries[0]!.id)
            : [],
          page.entries,
        ),
        logHasMore: s.log.length > LOG_PAGE ? s.logHasMore : page.hasMore,
        unread: page.unread,
        status: 'ready',
        error: null,
      }));
    } catch (err) {
      useAlerts.setState({ status: 'offline', error: errorMessage(err) });
      return;
    }
    await Promise.all([this.loadService(), this.loadChannels()]);
  }

  async loadService(): Promise<void> {
    try {
      useAlerts.setState({ service: await this.api.getAlertService() });
    } catch (err) {
      console.warn('alerts: service status unavailable', errorMessage(err));
    }
  }

  private async loadChannels(): Promise<void> {
    try {
      useAlerts.setState({ channels: await this.api.getAlertChannels() });
    } catch (err) {
      console.warn('alerts: channels unavailable', errorMessage(err));
    }
  }

  /** Newest log page (deliveries and read flags change); older loaded pages stay. */
  async loadLog(): Promise<void> {
    try {
      const page = await this.api.getAlertLog({ limit: LOG_PAGE });
      useAlerts.setState((s) => ({
        log: mergeLog(s.log, page.entries),
        unread: page.unread,
      }));
    } catch (err) {
      console.warn('alerts: log refresh failed', errorMessage(err));
    }
  }

  /** Next older page of the log. */
  async loadMoreLog(): Promise<void> {
    const { log, logHasMore } = useAlerts.getState();
    const oldest = log.at(-1);
    if (!logHasMore || !oldest) return;
    try {
      const page = await this.api.getAlertLog({ before: oldest.id, limit: LOG_PAGE });
      useAlerts.setState((s) => ({
        log: mergeLog(s.log, page.entries),
        logHasMore: page.hasMore,
        unread: page.unread,
      }));
    } catch (err) {
      this.error(`Log could not be loaded: ${errorMessage(err)}`);
    }
  }

  /** Refetch alerts by id (`alerts.changed`); a 404 means deleted. */
  async refetch(ids: string[]): Promise<void> {
    if (!ids.length) return;
    if (ids.length > REFETCH_BULK) {
      await this.load();
      return;
    }
    await Promise.all(
      ids.map(async (id) => {
        try {
          this.adopt(await this.api.getAlert(id));
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) this.drop(id);
          else console.warn('alerts: refetch failed', errorMessage(err));
        }
      }),
    );
  }

  private adopt(alert: Alert): void {
    useAlerts.setState((s) => {
      const cur = s.alerts[alert.id];
      if (cur && cur.revision > alert.revision) return s; // an older response arrived late
      return { alerts: { ...s.alerts, [alert.id]: alert } };
    });
  }

  private drop(id: string): void {
    useAlerts.setState((s) => {
      if (!(id in s.alerts)) return s;
      const alerts = { ...s.alerts };
      delete alerts[id];
      return { alerts };
    });
  }

  // ------------------------------------------------------------ mutations

  private conflict(server: Alert, restore: () => void): void {
    useAlerts.setState((s) => ({ alerts: { ...s.alerts, [server.id]: server } }));
    (
      this.opts.onConflict ??
      ((name, run) =>
        actionToast(
          `Alert “${name}” was changed elsewhere; the saved version is shown.`,
          [{ label: 'Keep mine', run }],
          'error',
          10_000,
        ))
    )(server.name, restore);
  }

  /** POST. Throws on failure (the dialog shows it). An existing id (retried POST) adopts the stored alert. */
  async createAlert(body: AlertIn): Promise<Alert> {
    const withId: AlertIn = { ...body, id: body.id ?? crypto.randomUUID() };
    let saved: Alert;
    try {
      saved = await this.api.createAlert(withId);
    } catch (err) {
      const existing = alertsApi.alertConflict(err);
      if (!existing) throw err;
      saved = existing;
    }
    this.adopt(saved);
    return saved;
  }

  /**
   * PUT the alert with `patch` applied. `revision` is the one the edit was
   * based on (omit to overwrite). Resolves to null on a 409, after adopting
   * the stored alert and offering "Keep mine". Other failures throw.
   */
  async updateAlert(
    id: string,
    patch: Partial<EditableFields>,
    revision?: number,
  ): Promise<Alert | null> {
    const cur = useAlerts.getState().alerts[id];
    if (!cur) throw new Error('Alert not found');
    const body: alertsApi.AlertUpdate = {
      ...editable(cur),
      ...patch,
      ...(revision !== undefined ? { revision } : {}),
    };
    try {
      const saved = await this.api.updateAlert(id, body);
      this.adopt(saved);
      return saved;
    } catch (err) {
      const server = alertsApi.alertConflict(err);
      if (!server) throw err;
      this.conflict(server, () => {
        this.updateAlert(id, patch).catch((e) => this.error(`Alert not saved: ${errorMessage(e)}`));
      });
      return null;
    }
  }

  /** Pause / restart. 409: as `updateAlert`. Other errors are shown as a toast. */
  async setAlertStatus(
    id: string,
    status: 'active' | 'paused',
    extra: { expiresAt?: string | null } = {},
  ): Promise<Alert | null> {
    const cur = useAlerts.getState().alerts[id];
    if (!cur) return null;
    try {
      const saved = await this.api.patchAlert(id, { status, ...extra, revision: cur.revision });
      this.adopt(saved);
      return saved;
    } catch (err) {
      const server = alertsApi.alertConflict(err);
      if (server) {
        this.conflict(server, () => {
          this.api
            .patchAlert(id, { status, ...extra })
            .then((a) => this.adopt(a))
            .catch((e) => this.error(`Alert not saved: ${errorMessage(e)}`));
        });
      } else this.error(`Alert not updated: ${errorMessage(err)}`);
      return null;
    }
  }

  /** DELETE; a 404 counts as done. Resolves to whether the alert is gone. */
  async deleteAlert(id: string): Promise<boolean> {
    try {
      await this.api.deleteAlert(id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        this.error(`Alert not deleted: ${errorMessage(err)}`);
        return false;
      }
    }
    this.drop(id);
    return true;
  }

  /** Open the dialog with a copy (new id, "<name> (copy)", paused until saved; built by the dialog). */
  cloneAlert(id: string): void {
    if (!useAlerts.getState().alerts[id]) return;
    if (!commands.get('alert.create')) {
      toast('The alert dialog is not available', 'error');
      return;
    }
    commands.execute('alert.create', { cloneOf: id });
  }

  // ------------------------------------------------------------ log

  /** Mark entries up to `upTo` read (all loaded when omitted). */
  async markLogRead(upTo?: number): Promise<void> {
    const target = upTo ?? useAlerts.getState().log[0]?.id;
    if (target === undefined) return;
    useAlerts.setState((s) => ({
      log: s.log.map((e) => (e.id <= target && !e.read ? { ...e, read: true } : e)),
    }));
    try {
      const { unread } = await this.api.markAlertLogRead({ upTo: target });
      useAlerts.setState({ unread });
    } catch (err) {
      console.warn('alerts: could not mark read', errorMessage(err));
      void this.loadLog();
    }
  }

  async clearLog(alertId?: string): Promise<void> {
    try {
      await this.api.clearAlertLog(alertId);
    } catch (err) {
      this.error(`Log not cleared: ${errorMessage(err)}`);
      return;
    }
    useAlerts.setState((s) => {
      const log = alertId ? s.log.filter((e) => e.alertId !== alertId) : [];
      return {
        log,
        unread: log.filter((e) => !e.read).length,
        logHasMore: alertId ? s.logHasMore : false,
      };
    });
    void this.loadLog();
  }
}

let instance: AlertsSync | null = null;
const shared = (): AlertsSync => (instance ??= new AlertsSync());

/** Start syncing alerts (from `persist/bootstrap.ts`); returns the stop function. */
export function startAlertsSync(): () => void {
  const sync = shared();
  sync.start();
  return () => sync.stop();
}

export const getAlertsSync = shared;
export const createAlert = (body: AlertIn) => shared().createAlert(body);
export const updateAlert = (id: string, patch: Partial<EditableFields>, revision?: number) =>
  shared().updateAlert(id, patch, revision);
export const setAlertStatus = (
  id: string,
  status: 'active' | 'paused',
  extra?: { expiresAt?: string | null },
) => shared().setAlertStatus(id, status, extra);
export const deleteAlert = (id: string) => shared().deleteAlert(id);
export const cloneAlert = (id: string) => shared().cloneAlert(id);
export const markLogRead = (upTo?: number) => shared().markLogRead(upTo);
export const clearAlertLog = (alertId?: string) => shared().clearLog(alertId);
export const loadMoreAlertLog = () => shared().loadMoreLog();
