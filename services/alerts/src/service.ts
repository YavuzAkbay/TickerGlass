/**
 * The evaluation service (docs/alerts.md §3.2): wires registry, control
 * socket, series, fire queue, state store and heartbeat around injectable
 * `api`, `control`, `feed` and `clock`.
 */
import type { Alert, AlertRuntimeState } from '@tickerglass/alerts';
import { seriesKey, specRefs, validateAlert } from '@tickerglass/alerts';
import {
  resolveInputs,
  scriptIdOf,
  USER_SCRIPT_API_VERSION,
  USER_SCRIPT_PREFIX,
} from '@tickerglass/indicators';
import type { DataFeed, LiveStatus, Unsubscribe } from '@tickerglass/engine/node';
import { ApiError, type ApiClient, type StateRow } from './api';
import { AlertRunner } from './alert-runner';
import { backoffMs, jitter, type Clock } from './clock';
import type { Config } from './config';
import type { ControlLike } from './control';
import { FireQueue } from './fires';
import { Heartbeat } from './heartbeat';
import { errText, type Logger } from './log';
import { ServiceMetrics } from './metrics';
import { Registry } from './registry';
import { ScriptCatalog, type StoredScript } from './scripts/catalog';
import { ScriptHost } from './scripts/host';
import { Series, type SeriesHost } from './series';
import { StateStore } from './state';

/**
 * Stamped by esbuild (`--define:__VERSION__`) from TICKERGLASS_VERSION in Docker;
 * source checkouts and tests report "dev".
 */
export const SERVICE_VERSION: string = typeof __VERSION__ === 'string' ? __VERSION__ : 'dev';
const SYNC_MS = 60_000;
const DOWN_SYNC_MS = 10_000;
const LIVE_CAP = 200;
const LIVE_DOWN_MS = 20_000;
const BULK_IDS = 20;
const STOP_FIRE_WAIT_MS = 4000;
/** Of `config.shutdownMs`, left for the caller to dispose of the rest and exit. */
const STOP_SLACK_MS = 2000;
const MAX_PENDING_PERSISTED = 20;
const MAX_STATE_BYTES = 12 * 1024;
/** Series loading their history at once after a provider change (each load costs provider credits). */
const REATTACH_CONCURRENCY = 2;
/** Alerts leaving the waiting list start 2 to 10 s after their script is back. */
const RESUME_JITTER_MIN_MS = 2000;
const RESUME_JITTER_SPAN_MS = 8000;

/** An alert's script instances: where its scripts are, and which output it reads. */
interface ScriptUse {
  scriptId: string;
  inputs: Record<string, unknown>;
  /** Output the alert reads from this instance, when it is the operand's target. */
  outputId: string | null;
}

/** The user-script instances an alert's indicator operands use. Empty for a malformed spec. */
function scriptUses(spec: Alert['spec']): ScriptUse[] {
  const out: ScriptUse[] = [];
  try {
    for (const ref of specRefs(spec))
      for (const inst of ref.instances) {
        const scriptId = scriptIdOf(inst.type);
        if (scriptId !== undefined)
          out.push({
            scriptId,
            inputs: inst.inputs,
            outputId: inst.id === ref.instanceId ? ref.outputId : null,
          });
      }
  } catch {
    return [];
  }
  return out;
}

/** Why an alert on scripts cannot be attached (see `scriptProblem`). */
type ScriptProblem =
  | { kind: 'defer' }
  | { kind: 'wait'; reason: string }
  | { kind: 'compile'; scriptId: string }
  | { kind: 'error'; reason: string };

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
  /** Forget resolved symbols in every feed layer (the data provider changed). */
  clearSymbolCache?: (() => void) | undefined;
  /**
   * User-script isolates (owned by the caller, who disposes them after `stop`).
   * Absent = alerts on scripts are refused with an error status.
   */
  scripts?: ScriptHost | undefined;
}

export interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Full resync (tests). */
  sync(ids?: string[]): Promise<void>;
  /** Resolves when sync and every series finished their queued work (tests). */
  whenIdle(): Promise<void>;
  series(): Series[];
  /** Alerts waiting for a script that is out for now: why, and the clock time they start again. */
  waiting(): { alertId: string; reason: string; resumeAt: number }[];
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
  const metrics = new ServiceMetrics();
  let stopped = false;
  let lastError: string | null = null;
  let notOpenSince: number | null = null;
  let chain: Promise<void> = Promise.resolve();
  /** The API's data provider as last seen; undefined = not known yet. */
  let activeProvider: string | null | undefined;

  const catalog = new ScriptCatalog();
  const scripts =
    deps.scripts ??
    ScriptHost.disabled('user scripts are not available on this server', clock, log);
  /** Alerts on scripts that wait for the first successful load of the script list. */
  const deferred = new Set<string>();
  scripts.onFault((scriptId, _reason, hold) => {
    metrics.scriptFaults++;
    for (const s of seriesMap.values()) s.onScriptFault(scriptId, hold);
  });
  /**
   * Alerts waiting for a script that is out for now (fault hold, isolate replaced): not
   * attached, status unchanged (the API has no transient status), re-attached by `tick`
   * once the script is usable again (a few seconds spread out, so alerts on one script do not
   * all reload their history at the same moment). Value: why they wait, and from when.
   */
  const suspended = new Map<string, { reason: string; resumeAt: number }>();
  /** Alerts whose script is being compiled to find out why it has no manifest. */
  const compiling = new Set<string>();

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
    metrics,
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
    scripts,
    metrics,
    registry: () => catalog.registry(),
    enqueueFire(job) {
      metrics.firesQueued++;
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
    alertSuspended: (runner, reason) => suspendRunner(runner, reason),
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
        metrics.statusPostFailures++;
        log.warn('status post failed', { alertId: alert.id, error: errText(err) });
        lastError = errText(err);
      }
    }
    void sync([alert.id]);
  }

  // ------------------------------------------------------ attach / detach

  function detach(id: string): void {
    deferred.delete(id);
    suspended.delete(id);
    compiling.delete(id);
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

  /**
   * Script-specific reasons an alert cannot run, found without running code. `defer`: the
   * script list was never loaded. `wait`: the script is held off after a fault, the alert
   * waits. `compile`: the script has no saved manifest; compiling it says why. `error`: the
   * message of the error status. Existing `checkRegistry` rules (repaint, script-as-source)
   * are left to `validateAlert`.
   */
  function scriptProblem(alert: Alert): ScriptProblem | null {
    const uses = scriptUses(alert.spec);
    if (uses.length === 0) return null;
    if (!catalog.loaded) return { kind: 'defer' };
    const reg = catalog.registry();
    for (const use of uses) {
      const s = catalog.get(use.scriptId, alert.ownerId);
      if (!s) return { kind: 'error', reason: 'script was deleted' };
      if (s.apiVersion !== USER_SCRIPT_API_VERSION)
        return {
          kind: 'error',
          reason: `script uses an unsupported API version (${s.apiVersion})`,
        };
      const hold = scripts.hold(use.scriptId);
      if (hold && !hold.final) return { kind: 'wait', reason: hold.reason };
      const unavailable = scripts.unavailable(use.scriptId);
      if (unavailable !== null) return { kind: 'error', reason: unavailable };
      if (!s.manifest || !reg.get(USER_SCRIPT_PREFIX + s.id))
        return { kind: 'compile', scriptId: use.scriptId };
      const def = reg.get(USER_SCRIPT_PREFIX + s.id)!;
      let inputsOk = Object.keys(use.inputs).every((k) => k in def.inputs);
      if (inputsOk) {
        try {
          resolveInputs(def, use.inputs as never);
        } catch {
          inputsOk = false;
        }
      }
      if (!inputsOk) return { kind: 'error', reason: 'script inputs changed — edit the alert' };
      if (
        use.outputId !== null &&
        !def.outputs.some((o) => o.id === use.outputId && o.type === 'plot')
      )
        return {
          kind: 'error',
          reason: `script output '${use.outputId}' no longer exists — edit the alert`,
        };
    }
    return null;
  }

  /**
   * A script without a saved manifest: compile it (in its isolate) to say why, then report.
   * The alert may have been edited, removed or attached meanwhile.
   */
  async function reportNoManifest(alert: Alert, scriptId: string): Promise<void> {
    if (compiling.has(alert.id)) return;
    compiling.add(alert.id);
    let reason: string;
    try {
      const r = await scripts.ensure(scriptId);
      reason = r.ok
        ? 'script has no saved manifest: open it in the editor and save it again'
        : r.reason;
    } catch (err) {
      reason = `script check failed: ${errText(err)}`;
      log.warn('compiling a script failed', { scriptId, error: errText(err) });
    }
    const still = compiling.delete(alert.id);
    const cur = registry.get(alert.id);
    if (stopped || !still || !cur || cur.revision !== alert.revision || cur.status !== 'active')
      return;
    if (runners.has(alert.id) || suspended.has(alert.id)) return;
    void report(alert, 'error', reason.slice(0, 500));
  }

  /** `alert` waits for its script: no runner, status unchanged. `tick` attaches it again. */
  function suspendAlert(alert: Alert, reason: string): void {
    const now = clock.now();
    let from = now;
    for (const u of scriptUses(alert.spec))
      from = Math.max(from, scripts.hold(u.scriptId)?.retryAt ?? 0);
    const resumeAt = from + RESUME_JITTER_MIN_MS + Math.random() * RESUME_JITTER_SPAN_MS;
    suspended.set(alert.id, { reason, resumeAt });
    log.warn('alert waits for its script', { alertId: alert.id, reason, resumeAt });
  }

  /** A runner whose script went out: detach it keeping its state (previous sample cleared). */
  function suspendRunner(runner: AlertRunner, reason: string): void {
    if (runners.get(runner.id) !== runner) return;
    carryState([runner]);
    const alert = runner.alert;
    detach(runner.id);
    suspendAlert(alert, reason);
  }

  /**
   * Attach again the waiting alerts whose scripts are usable: all of them whose scripts have
   * no hold (`only` unset), or those using one of the `only` scripts (a new revision ends a
   * hold). Pending fires saved with their state go out again.
   */
  function resumeSuspended(only?: ReadonlySet<string>, skip?: ReadonlySet<string>): Set<string> {
    const carried: StateRow[] = [];
    const resumed = new Set<string>();
    const now = clock.now();
    for (const [id, wait] of [...suspended]) {
      if (skip?.has(id)) continue;
      const a = registry.get(id);
      if (!a || a.status !== 'active') {
        suspended.delete(id);
        continue;
      }
      const uses = scriptUses(a.spec);
      if (only) {
        if (!uses.some((u) => only.has(u.scriptId))) continue;
      } else if (now < wait.resumeAt || uses.some((u) => scripts.hold(u.scriptId) !== null))
        continue;
      suspended.delete(id);
      const row = savedRows.get(id);
      if (row) carried.push(row);
      resumed.add(id);
      attach(a);
    }
    if (resumed.size === 0) return resumed;
    resendPending(carried);
    log.info('alerts on a script resumed', { alerts: resumed.size, waiting: suspended.size });
    return resumed;
  }

  function attach(alert: Alert): void {
    if (alert.expiresAt && Date.parse(alert.expiresAt) <= clock.now()) {
      void report(alert, 'expired', '');
      return;
    }
    const { id, name, symbol, interval, prepost, spec, message, notify, expiresAt } = alert;
    const problem = scriptProblem(alert);
    if (problem?.kind === 'defer') {
      deferred.add(alert.id);
      return;
    }
    if (problem?.kind === 'wait') {
      suspendAlert(alert, problem.reason);
      return;
    }
    if (problem?.kind === 'compile') {
      void reportNoManifest(alert, problem.scriptId);
      return;
    }
    if (problem?.kind === 'error') {
      void report(alert, 'error', problem.reason.slice(0, 500));
      return;
    }
    const v = validateAlert(
      { id, name, symbol, interval, prepost, spec, message, notify, expiresAt },
      catalog.registry(),
    );
    if (!v.ok) {
      void report(
        alert,
        'error',
        `invalid alert: ${v.errors[0]?.message ?? 'validation failed'}`.slice(0, 500),
      );
      return;
    }
    // validateAlert upgrades legacy indicator ids; build from that spec so they resolve.
    const live: Alert = { ...alert, spec: v.alert.spec };
    let runner: AlertRunner;
    let series: Series;
    try {
      runner = new AlertRunner(live, {
        minRefireMs: config.minRefireS * 1000,
        graceS: config.closeGraceS,
        registry: catalog.registry(),
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

  async function fetchScripts(): Promise<StoredScript[] | null> {
    try {
      return await api.listUserScripts();
    } catch (err) {
      log.warn('could not load user scripts', { error: errText(err) });
      return null;
    }
  }

  /** Take a fresh script list into the catalog and the isolates. Synchronous. Returns the changed ids. */
  function applyScripts(stored: StoredScript[] | null): string[] {
    if (!stored) return [];
    const changed = catalog.apply(stored);
    scripts.setScripts(catalog.list());
    return changed;
  }

  /**
   * An alert whose script is edited or deleted restarts: its series reloads
   * history, the script is recomputed, and the previous sample is cleared
   * (the rest of the state is kept), so the edit itself cannot fire a crossing.
   * An alert that needs a script it can no longer have ends in `error`.
   */
  function restartForScripts(changed: readonly string[], skip: ReadonlySet<string>): void {
    if (changed.length === 0) return;
    // A new revision ends a hold: alerts waiting for the script try it at once.
    const resumed = resumeSuspended(new Set(changed), skip);
    // Just attached from the waiting list: already on the new revision, and already resent.
    const hit = [...runners.values()].filter(
      (r) =>
        !skip.has(r.id) && !resumed.has(r.id) && r.scriptIds.some((id) => changed.includes(id)),
    );
    if (hit.length === 0) return;
    const carried = carryState(hit);
    for (const r of hit) detach(r.id);
    for (const r of hit) {
      const a = registry.get(r.id);
      if (a && a.status === 'active') attach(a);
    }
    resendPending(carried);
    log.info('user script changed, alerts restarted', { alerts: hit.length, scripts: changed });
  }

  /**
   * Remember each runner's state as it would restart: its own, or the saved one for a runner
   * never seeded, with the previous sample cleared and the unacknowledged fires attached.
   */
  function carryState(rs: readonly AlertRunner[]): StateRow[] {
    const carried: StateRow[] = [];
    for (const r of rs) {
      const saved = savedRows.get(r.id);
      const base = !r.seeded && saved?.revision === r.revision ? saved.state : stateWithPending(r);
      const row: StateRow = {
        alertId: r.id,
        revision: r.revision,
        state: { ...base, prev: null },
      };
      savedRows.set(r.id, row);
      carried.push(row);
    }
    return carried;
  }

  /** Alerts that waited for the first script list, attached once it is there. */
  function attachDeferred(): void {
    if (!catalog.loaded) return;
    for (const id of [...deferred]) {
      deferred.delete(id);
      const a = registry.get(id);
      if (a && a.status === 'active' && !runners.has(id)) attach(a);
    }
  }

  /** Make sure the catalog knows every script `a` uses (a script just created is not in it yet). */
  async function prepareScripts(a: Alert): Promise<void> {
    if (a.status !== 'active') return;
    const uses = scriptUses(a.spec);
    if (uses.length === 0) return;
    if (catalog.loaded && uses.every((u) => catalog.get(u.scriptId, a.ownerId))) return;
    const changed = applyScripts(await fetchScripts());
    restartForScripts(changed, new Set([a.id]));
  }

  async function applyAlert(a: Alert): Promise<void> {
    await prepareScripts(a);
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
      const stored = await fetchScripts();
      const list = await api.listAlerts();
      // Everything below is synchronous: no bar can arrive between the scripts changing and
      // their alerts restarting.
      const scriptsChanged = applyScripts(stored);
      const diff = registry.apply(list);
      for (const a of diff.removed) detach(a.id);
      const attached = new Set<string>();
      for (const a of [...diff.added, ...diff.changed]) {
        detach(a.id);
        attached.add(a.id);
        if (a.status === 'active') attach(a);
      }
      restartForScripts(scriptsChanged, attached);
      attachDeferred();
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

  /**
   * The API switched its data provider: every series holds bars of the old one. Persist the
   * states, then rebuild every runner (its series reloads history from the new provider).
   *
   * Each runner's state is carried over instead of dropped: a fresh runner with no state would
   * sample the new history as a first look and re-fire level conditions that already fired on
   * the current bar (or, in close mode, a "missed" catch-up), and lose its pending fires.
   */
  async function doReattachAll(): Promise<void> {
    if (stopped) return;
    await states.flush();
    deps.clearSymbolCache?.();
    const carried: StateRow[] = [];
    for (const r of [...runners.values()]) {
      // A runner that never got seeded (its series was still loading) holds no state of its
      // own: keep the saved row it would have been seeded from (mirrors host.savedState).
      const saved = savedRows.get(r.id);
      const row =
        !r.seeded && saved?.revision === r.revision
          ? saved
          : { alertId: r.id, revision: r.revision, state: stateWithPending(r) };
      savedRows.set(r.id, row);
      carried.push(row);
    }
    for (const id of [...runners.keys()]) detach(id);
    // Stagger the history reloads: each series attaches (and loads) a few at a time instead of
    // every series hitting the new provider at once.
    const groups = new Map<string, Alert[]>();
    for (const a of registry.all()) {
      if (a.status !== 'active') continue;
      const key = seriesKey(a.symbol, a.interval, a.prepost);
      const g = groups.get(key);
      if (g) g.push(a);
      else groups.set(key, [a]);
    }
    const queue = [...groups.values()];
    const worker = async (): Promise<void> => {
      for (let g = queue.shift(); g && !stopped; g = queue.shift()) {
        for (const a of g) attach(a);
        const key = seriesKey(g[0]!.symbol, g[0]!.interval, g[0]!.prepost);
        await seriesMap.get(key)?.whenIdle();
      }
    };
    await Promise.all(Array.from({ length: REATTACH_CONCURRENCY }, worker));
    resendPending(carried);
    log.info('data provider changed, alerts re-attached', { alerts: runners.size });
  }

  function reattachAll(): Promise<void> {
    chain = chain.then(() =>
      doReattachAll().catch((err: unknown) => {
        lastError = errText(err);
        log.warn('re-attach after a provider change failed', { error: lastError });
      }),
    );
    return chain;
  }

  /**
   * Compare the API's active provider with the one remembered. A switch announced while the
   * control socket was down (or lost in transit) shows up here. Failures are not errors: the
   * next resync asks again.
   */
  async function fetchProvider(): Promise<string | null | undefined> {
    try {
      return await api.activeProvider();
    } catch (err) {
      log.debug('could not read the active data provider', { error: errText(err) });
      return undefined;
    }
  }

  async function checkProvider(): Promise<void> {
    if (stopped) return;
    const id = await fetchProvider();
    if (id === undefined) return;
    const before = activeProvider;
    activeProvider = id;
    if (before !== undefined && before !== id) {
      log.info('data provider changed while not listening', { from: before, to: id });
      await reattachAll();
    }
  }

  async function onProviderEvent(): Promise<void> {
    const done = reattachAll();
    // Remember the new provider so the next resync does not reattach a second time; unknown
    // after a failed read (the next successful read just records it).
    activeProvider = await fetchProvider();
    await done;
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
    if (suspended.size > 0) resumeSuspended();
  }

  function stats() {
    const all = [...seriesMap.values()];
    const live = new Set<string>();
    let polled = 0;
    for (const s of all) {
      if (s.polled) polled++;
      if (!capped.has(s)) for (const x of s.liveSymbols) live.add(x);
    }
    const waiting = [...suspended].map(([alertId, w]) => ({ alertId, ...w }));
    return {
      series: all.length,
      liveSymbols: live.size,
      polledSeries: polled,
      lastError,
      waiting,
      metrics: metrics.snapshot(fires.pending),
    };
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
        // stop() cancels the timer: it must also end the wait, or start() never returns.
        await new Promise<void>((resolve) => {
          const c = clock.setTimeout(resolve, ms);
          cancels.push(() => {
            c();
            resolve();
          });
        });
      }
    }
  }

  /** Alerts plus the drawings of every series that uses any (events may have been missed). */
  async function resync(): Promise<void> {
    const provider = checkProvider(); // alongside the sync: one round trip, not two
    await sync();
    for (const s of seriesMap.values()) s.resyncDrawings();
    await provider;
  }

  /** Re-send fires a previous run accepted but never saw acknowledged (idempotent by fireId). */
  function resendPending(rows: Iterable<StateRow> = savedRows.values()): void {
    for (const row of rows) {
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
    // stop() may run during any await below: it clears `cancels`, so whatever is registered
    // after it would run (and keep the process alive) for good.
    if (stopped) return;
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
    control.onProviderChanged(() => void onProviderEvent());
    activeProvider = await fetchProvider();
    if (stopped) return;
    control.start();
    await sync();
    if (stopped) return;
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
    const began = clock.now();
    for (const c of cancels) c();
    cancels.length = 0;
    heartbeat.stop();
    control.stop();
    // Persist the state (queued fires included) right away, alongside the wait for the queue:
    // a slow API must not eat the whole budget before the first write is even attempted.
    for (const r of runners.values()) host.markState(r);
    void states.flush();
    // Give queued fires a moment to go out; whatever is left is persisted with the state.
    const budget = Math.max(1000, config.shutdownMs - STOP_SLACK_MS);
    const wait = (ms: number, p: Promise<void>): Promise<void> => {
      let cancel = (): void => {};
      const timer = new Promise<void>((resolve) => {
        cancel = clock.setTimeout(resolve, Math.max(0, ms));
      });
      return Promise.race([p, timer]).finally(() => cancel());
    };
    await wait(Math.min(STOP_FIRE_WAIT_MS, budget / 2), fires.whenIdle());
    fires.stop();
    for (const r of runners.values()) host.markState(r);
    for (const s of seriesMap.values()) s.dispose();
    seriesMap.clear();
    suspended.clear();
    // Flushes are serialized: this one follows the early write. Bounded, so a dead API cannot
    // hold the process past the entry point's force-exit.
    await wait(budget - (clock.now() - began), states.flush());
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
    waiting: () => [...suspended].map(([alertId, w]) => ({ alertId, ...w })),
    registry,
    fires,
  };
}
