/**
 * The evaluation service (docs/alerts.md §3.2): wires registry, control
 * socket, series, fire queue, state store and heartbeat around injectable
 * `api`, `control`, `feed` and `clock`.
 */
import type { Alert, AlertRuntimeState } from '@tickerglass/alerts';
import { seriesKey, validateAlert } from '@tickerglass/alerts';
import type { DataFeed, LiveStatus, Unsubscribe } from '@tickerglass/engine/node';
import { ApiError, type ApiClient, type StateRow } from './api';
import { AlertRunner } from './alert-runner';
import { backoffMs, jitter, type Clock } from './clock';
import type { Config } from './config';
import type { ControlLike } from './control';
import { FireQueue } from './fires';
import { Heartbeat } from './heartbeat';
import { errText, type Logger } from './log';
import { Registry } from './registry';
import { Series, type SeriesHost } from './series';
import { StateStore } from './state';

export const SERVICE_VERSION = '0.1.0';
const SYNC_MS = 60_000;
const DOWN_SYNC_MS = 10_000;
const LIVE_CAP = 200;
const LIVE_DOWN_MS = 20_000;
const BULK_IDS = 20;
const STOP_FIRE_WAIT_MS = 4000;
const MAX_PENDING_PERSISTED = 20;
const MAX_STATE_BYTES = 12 * 1024;

export interface ServiceDeps {
  api: ApiClient;
  control: ControlLike;
  feed: DataFeed;
  clock: Clock;
  config: Config;
  log: Logger;
  /** The live socket's status source (HttpDataFeed.onStatus); absent = never "down". */
  live?: { onStatus(fn: (s: LiveStatus) => void): Unsubscribe } | undefined;
  /** Release the feed's sockets on stop. */
  disposeFeed?: (() => void) | undefined;
}

export interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Full resync (tests). */
  sync(ids?: string[]): Promise<void>;
  /** Resolves when sync and every series finished their queued work (tests). */
  whenIdle(): Promise<void>;
  series(): Series[];
  readonly registry: Registry;
  readonly fires: FireQueue;
}

export function createService(deps: ServiceDeps): Service {
  const { api, control, feed, clock, config, log } = deps;
  const registry = new Registry();
  const seriesMap = new Map<string, Series>();
  const runners = new Map<string, AlertRunner>();
  const savedRows = new Map<string, StateRow>();
  const reported = new Set<string>();
  const capped = new Set<Series>();
  const cancels: (() => void)[] = [];
  const startedAt = clock.now();
  let stopped = false;
  let lastError: string | null = null;
  let notOpenSince: number | null = null;
  let chain: Promise<void> = Promise.resolve();

  const states = new StateStore(api, log);
  const fires: FireQueue = new FireQueue({
    api,
    clock,
    log,
    onConflict: (id) => void sync([id]),
    onFired: (job) => {
      lastError = null;
      // The fire is acknowledged: persist the state without it.
      const r = runners.get(job.alertId);
      if (r && r.revision === job.revision) host.markState(r);
    },
    onError: (m) => {
      lastError = m;
    },
  });

  /** Evaluator state plus the still-unacknowledged fires (resent after a restart). */
  function stateWithPending(runner: AlertRunner): AlertRuntimeState {
    const st = runner.evaluator.state();
    let pending = fires
      .pendingFor(runner.id)
      .filter((j) => j.revision === runner.revision)
      .map((j) => ({ revision: j.revision, body: j.body }));
    // The API rejects state blobs over 16 KB: bound the persisted copy.
    if (pending.length > MAX_PENDING_PERSISTED) {
      const keepFirst = runner.alert.spec.trigger !== 'everyTime';
      pending = keepFirst
        ? pending.slice(0, MAX_PENDING_PERSISTED)
        : pending.slice(-MAX_PENDING_PERSISTED);
    }
    let out: AlertRuntimeState = pending.length ? { ...st, pendingFires: pending } : st;
    let dropped = 0;
    while (pending.length > 0 && JSON.stringify(out).length > MAX_STATE_BYTES) {
      pending = pending.slice(1);
      dropped++;
      out = pending.length ? { ...st, pendingFires: pending } : st;
    }
    if (dropped > 0)
      log.warn('pending fires trimmed to fit the state size limit', {
        alertId: runner.id,
        dropped,
      });
    return out;
  }

  // --------------------------------------------------------------- host

  const host: SeriesHost = {
    feed,
    api,
    clock,
    log,
    cfg: config,
    enqueueFire(job) {
      fires.enqueue(job);
      const r = runners.get(job.alertId);
      if (r) host.markState(r);
    },
    markState(runner) {
      states.mark(runner.id, runner.revision, () => stateWithPending(runner));
    },
    savedState(runner): AlertRuntimeState | null {
      if (runner.seeded) return runner.evaluator.state();
      const row = savedRows.get(runner.id);
      return row && row.revision === runner.revision ? row.state : null;
    },
    alertError: (alert, reason) => void report(alert, 'error', reason),
    alertExpired: (alert) => void report(alert, 'expired', ''),
    liveDown: () => notOpenSince !== null && clock.now() - notOpenSince >= LIVE_DOWN_MS,
    overCap: (s) => capped.has(s),
    onError: (m) => {
      lastError = m;
    },
  };

  const unLive = deps.live?.onStatus((s) => {
    if (s.connection === 'open' || s.connection === 'idle') notOpenSince = null;
    else if (notOpenSince === null) notOpenSince = clock.now();
  });
  if (unLive) cancels.push(unLive);

  async function report(alert: Alert, status: 'expired' | 'error', reason: string): Promise<void> {
    detach(alert.id);
    const key = `${alert.id}:${alert.revision}`;
    if (reported.has(key)) return;
    reported.add(key);
    log.info(`alert ${status}`, { alertId: alert.id, reason });
    try {
      await api.setStatus(alert.id, { revision: alert.revision, status, reason });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        log.info('status post rejected (stale), reloading', { alertId: alert.id });
      } else {
        reported.delete(key);
        log.warn('status post failed', { alertId: alert.id, error: errText(err) });
        lastError = errText(err);
      }
    }
    void sync([alert.id]);
  }

  // ------------------------------------------------------ attach / detach

  function detach(id: string): void {
    const r = runners.get(id);
    runners.delete(id);
    fires.drop(id);
    states.forget(id);
    for (const [key, s] of seriesMap) {
      if (r) s.removeAlert(id);
      if (s.runners.size === 0) {
        s.dispose();
        seriesMap.delete(key);
        capped.delete(s);
      }
    }
  }

  function attach(alert: Alert): void {
    if (alert.expiresAt && Date.parse(alert.expiresAt) <= clock.now()) {
      void report(alert, 'expired', '');
      return;
    }
    const { id, name, symbol, interval, prepost, spec, message, notify, expiresAt } = alert;
    const v = validateAlert({
      id,
      name,
      symbol,
      interval,
      prepost,
      spec,
      message,
      notify,
      expiresAt,
    });
    if (!v.ok) {
      void report(
        alert,
        'error',
        `invalid alert: ${v.errors[0]?.message ?? 'validation failed'}`.slice(0, 500),
      );
      return;
    }
    let runner: AlertRunner;
    let series: Series;
    try {
      runner = new AlertRunner(alert, {
        minRefireMs: config.minRefireS * 1000,
        graceS: config.closeGraceS,
      });
      const key = seriesKey(alert.symbol, alert.interval, alert.prepost);
      const known = seriesMap.get(key);
      series = known ?? new Series(alert.symbol, alert.interval, alert.prepost, host);
      if (!known) seriesMap.set(series.key, series);
    } catch (err) {
      void report(alert, 'error', errText(err).slice(0, 500));
      return;
    }
    runners.set(alert.id, runner);
    series.addAlert(runner);
  }

  async function applyAlert(a: Alert): Promise<void> {
    const r = registry.upsert(a);
    if (r === 'same' && (runners.has(a.id) || a.status !== 'active')) return;
    detach(a.id);
    if (a.status === 'active') attach(a);
  }

  // --------------------------------------------------------------- sync

  async function doSync(ids?: string[]): Promise<void> {
    if (stopped) return;
    try {
      if (ids && ids.length > 0 && ids.length <= BULK_IDS) {
        for (const id of ids) {
          try {
            await applyAlert(await api.getAlert(id));
          } catch (err) {
            if (err instanceof ApiError && err.status === 404) {
              registry.remove(id);
              detach(id);
            } else throw err;
          }
        }
        lastError = null;
        return;
      }
      const list = await api.listAlerts();
      const diff = registry.apply(list);
      for (const a of diff.removed) detach(a.id);
      for (const a of [...diff.added, ...diff.changed]) {
        detach(a.id);
        if (a.status === 'active') attach(a);
      }
      // Alerts equal in registry but never attached (e.g. a failed attach) stay as they are.
      lastError = null;
    } catch (err) {
      lastError = errText(err);
      log.warn('sync failed', { error: lastError });
    }
  }

  function sync(ids?: string[]): Promise<void> {
    chain = chain.then(() => doSync(ids));
    return chain;
  }

  // -------------------------------------------------------------- clock

  function recomputeCap(): void {
    capped.clear();
    const live = new Set<string>();
    const ordered = [...seriesMap.values()].sort((a, b) => a.order - b.order);
    for (const s of ordered) {
      const syms = s.liveSymbols;
      const fresh = syms.filter((x) => !live.has(x));
      if (live.size + fresh.length > LIVE_CAP) capped.add(s);
      else for (const x of fresh) live.add(x);
    }
  }

  function tick(): void {
    const now = clock.now();
    recomputeCap();
    for (const s of [...seriesMap.values()]) s.onClock(now);
  }

  function stats() {
    const all = [...seriesMap.values()];
    const live = new Set<string>();
    let polled = 0;
    for (const s of all) {
      if (s.polled) polled++;
      if (!capped.has(s)) for (const x of s.liveSymbols) live.add(x);
    }
    return { series: all.length, liveSymbols: live.size, polledSeries: polled, lastError };
  }

  const heartbeat = new Heartbeat(api, clock, log, stats, SERVICE_VERSION, startedAt);

  // ------------------------------------------------------------- start

  async function waitForApi(): Promise<void> {
    for (let attempt = 0; !stopped; attempt++) {
      try {
        await api.health();
        return;
      } catch (err) {
        const ms = jitter(backoffMs(attempt, 1000, 60_000));
        log.warn('api unreachable, waiting', { error: errText(err), inMs: ms });
        await new Promise<void>((resolve) => {
          const c = clock.setTimeout(resolve, ms);
          cancels.push(c);
        });
      }
    }
  }

  /** Alerts plus the drawings of every series that uses any (events may have been missed). */
  async function resync(): Promise<void> {
    await sync();
    for (const s of seriesMap.values()) s.resyncDrawings();
  }

  /** Re-send fires a previous run accepted but never saw acknowledged (idempotent by fireId). */
  function resendPending(): void {
    for (const row of savedRows.values()) {
      const alert = registry.get(row.alertId);
      if (!alert || alert.revision !== row.revision) continue;
      for (const p of row.state.pendingFires ?? []) {
        if (p.revision !== row.revision) continue;
        fires.enqueue({ alertId: row.alertId, revision: p.revision, body: p.body });
      }
      const r = runners.get(row.alertId);
      if (r) host.markState(r);
    }
  }

  async function start(): Promise<void> {
    log.info('starting', { api: config.apiUrl });
    await waitForApi();
    if (stopped) return;
    try {
      for (const row of await api.listStates()) savedRows.set(row.alertId, row);
    } catch (err) {
      log.warn('could not load saved states', { error: errText(err) });
    }
    control.onAlertsChanged((ids, deleted) => {
      for (const id of deleted) {
        registry.remove(id);
        detach(id);
      }
      if (ids.length) void sync(ids);
    });
    control.onDrawingsChanged((ids, deleted) => {
      // A deleted drawing is listed only in `deleted`; the refetch then misses it.
      const all = [...ids, ...deleted];
      for (const s of seriesMap.values()) s.onDrawingsChanged(all);
    });
    control.onConnection((up) => {
      if (up) void resync();
    });
    control.start();
    await sync();
    resendPending();
    cancels.push(clock.setInterval(() => void resync(), SYNC_MS));
    cancels.push(clock.setInterval(() => !control.connected && void sync(), DOWN_SYNC_MS));
    cancels.push(clock.setInterval(tick, 1000));
    cancels.push(clock.setInterval(() => void states.flush(), config.stateFlushMs));
    heartbeat.start();
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;
    for (const c of cancels) c();
    cancels.length = 0;
    heartbeat.stop();
    control.stop();
    // Give queued fires a moment to go out; whatever is left is persisted with the state.
    let cancelWait = (): void => {};
    await Promise.race([
      fires.whenIdle(),
      new Promise<void>((resolve) => {
        cancelWait = clock.setTimeout(resolve, STOP_FIRE_WAIT_MS);
      }),
    ]);
    cancelWait();
    fires.stop();
    for (const r of runners.values()) host.markState(r);
    for (const s of seriesMap.values()) s.dispose();
    seriesMap.clear();
    await states.flush();
    deps.disposeFeed?.();
  }

  return {
    start,
    stop,
    sync,
    async whenIdle() {
      await chain;
      for (let i = 0; i < 3; i++) {
        await Promise.all([...seriesMap.values()].map((s) => s.whenIdle()));
        await chain;
      }
    },
    series: () => [...seriesMap.values()],
    registry,
    fires,
  };
}
