import type { Alert, AlertLogEntry } from '@investopen/alerts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertLogPage } from '../api/alerts';
import { ApiError } from '../api/client';
import type { EventFrame, EventSubscription } from '../quotes/stream';
import { onAlertFired, startAlertEvents } from './events';
import { useAlerts } from './store';
import { AlertsSync, type AlertsApi } from './sync';

const spec = {
  schemaVersion: 1,
  left: { kind: 'price', field: 'close' },
  condition: { op: 'crossing', right: { kind: 'value', value: 100 } },
  trigger: 'once',
} as Alert['spec'];

const alert = (id: string, o: Partial<Alert> = {}): Alert => ({
  id,
  name: id,
  symbol: 'AAPL',
  interval: '1D',
  prepost: false,
  spec,
  message: '',
  notify: {
    toast: true,
    sound: true,
    browser: false,
    webhook: false,
    webhookUrl: null,
    webhookRaw: false,
    telegram: false,
    email: false,
  },
  expiresAt: null,
  status: 'active',
  statusReason: null,
  drawingId: null,
  revision: 1,
  fireCount: 0,
  lastFiredAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  ...o,
});

const entry = (id: number, o: Partial<AlertLogEntry> = {}): AlertLogEntry => ({
  id,
  alertId: 'a',
  alertName: 'a',
  symbol: 'AAPL',
  interval: '1D',
  firedAt: new Date().toISOString(),
  barTime: 0,
  message: 'm',
  values: { x: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 },
  delayed: false,
  final: false,
  read: false,
  deliveries: [],
  ...o,
});

const conflict = (current: Alert) =>
  new ApiError('stale', 409, { detail: { message: 'stale', current } });

function makeApi(over: Partial<Record<keyof AlertsApi, unknown>> = {}) {
  const page: AlertLogPage = { entries: [], hasMore: false, unread: 0 };
  const api = {
    listAlerts: vi.fn(async () => [] as Alert[]),
    getAlertLog: vi.fn(async () => page),
    getAlertService: vi.fn(async () => ({ online: true })),
    getAlertChannels: vi.fn(async () => ({
      webhook: { configured: false, url: null },
      telegram: { configured: false },
      email: { configured: false, to: null },
    })),
    getAlert: vi.fn(),
    createAlert: vi.fn(),
    updateAlert: vi.fn(),
    patchAlert: vi.fn(),
    deleteAlert: vi.fn(),
    markAlertLogRead: vi.fn(),
    clearAlertLog: vi.fn(),
    ...over,
  };
  return api as unknown as AlertsApi;
}

beforeEach(() => {
  useAlerts.setState(useAlerts.getInitialState());
});

describe('AlertsSync mutations', () => {
  it('adopts the stored alert on 409 and "Keep mine" re-sends without a revision', async () => {
    const mine = alert('a', { revision: 1 });
    const server = alert('a', { revision: 3, name: 'theirs' });
    const api = makeApi({
      updateAlert: vi
        .fn()
        .mockRejectedValueOnce(conflict(server))
        .mockResolvedValueOnce(alert('a', { revision: 4, name: 'mine' })),
    });
    const onConflict = vi.fn();
    const sync = new AlertsSync({ api, onConflict });
    useAlerts.setState({ alerts: { a: mine } });

    const res = await sync.updateAlert('a', { name: 'mine' }, 1);
    expect(res).toBeNull();
    expect(vi.mocked(api.updateAlert).mock.calls[0]![1]).toMatchObject({
      name: 'mine',
      revision: 1,
    });
    expect(useAlerts.getState().alerts.a?.name).toBe('theirs');
    expect(onConflict).toHaveBeenCalledWith('theirs', expect.any(Function));

    onConflict.mock.calls[0]![1]();
    await vi.waitFor(() => expect(api.updateAlert).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.updateAlert).mock.calls[1]![1]).not.toHaveProperty('revision');
    await vi.waitFor(() => expect(useAlerts.getState().alerts.a?.name).toBe('mine'));
  });

  it('pause sends the known revision and adopts a 409 on stale', async () => {
    const server = alert('a', { revision: 2, status: 'paused' });
    const api = makeApi({ patchAlert: vi.fn().mockRejectedValue(conflict(server)) });
    const onConflict = vi.fn();
    const sync = new AlertsSync({ api, onConflict });
    useAlerts.setState({ alerts: { a: alert('a') } });
    expect(await sync.setAlertStatus('a', 'paused')).toBeNull();
    expect(api.patchAlert).toHaveBeenCalledWith('a', { status: 'paused', revision: 1 });
    expect(useAlerts.getState().alerts.a?.status).toBe('paused');
    expect(onConflict).toHaveBeenCalled();
  });

  it('create adopts the stored alert when the id exists (retried POST)', async () => {
    const stored = alert('x');
    const api = makeApi({ createAlert: vi.fn().mockRejectedValue(conflict(stored)) });
    const sync = new AlertsSync({ api });
    const res = await sync.createAlert({ ...stored, id: 'x', status: 'active' });
    expect(res).toEqual(stored);
    expect(useAlerts.getState().alerts.x).toEqual(stored);
  });

  it('delete treats 404 as done', async () => {
    const api = makeApi({ deleteAlert: vi.fn().mockRejectedValue(new ApiError('nf', 404)) });
    const sync = new AlertsSync({ api });
    useAlerts.setState({ alerts: { a: alert('a') } });
    expect(await sync.deleteAlert('a')).toBe(true);
    expect(useAlerts.getState().alerts).toEqual({});
  });
});

describe('AlertsSync load and events', () => {
  it('loads alerts and log, and goes offline when unreachable', async () => {
    const api = makeApi({
      listAlerts: vi.fn(async () => [alert('a')]),
      getAlertLog: vi.fn(async () => ({ entries: [entry(5)], hasMore: false, unread: 1 })),
    });
    await new AlertsSync({ api }).load();
    expect(useAlerts.getState()).toMatchObject({ status: 'ready', unread: 1 });
    expect(Object.keys(useAlerts.getState().alerts)).toEqual(['a']);

    const down = makeApi({ listAlerts: vi.fn().mockRejectedValue(new ApiError('x', 0)) });
    useAlerts.setState(useAlerts.getInitialState());
    await new AlertsSync({ api: down }).load();
    expect(useAlerts.getState().status).toBe('offline');
  });

  function harness(api: AlertsApi, now = () => Date.now()) {
    let sub: EventSubscription | undefined;
    const stream = {
      subscribeEvents: vi.fn((_t: string[], s: EventSubscription) => {
        sub = s;
        return () => undefined;
      }),
    };
    const sync = new AlertsSync({
      api,
      events: (o) => startAlertEvents({ ...o, stream, api, now }),
    });
    sync.start();
    const frame = (f: Omit<EventFrame, 'topic'> & { type: string }) =>
      sub!.onFrame({ topic: 'alerts', ...f });
    return { sync, stream, frame, open: (re: boolean) => sub!.onOpen?.(re) };
  }

  it('refetches by id on alerts.changed and removes deleted', async () => {
    const api = makeApi({ getAlert: vi.fn(async () => alert('a', { revision: 2, name: 'new' })) });
    const h = harness(api);
    await vi.waitFor(() => expect(useAlerts.getState().status).toBe('ready'));
    useAlerts.setState({ alerts: { a: alert('a'), b: alert('b') } });
    h.frame({ type: 'alerts.changed', ids: ['a', 'b'], deleted: ['b'] });
    await vi.waitFor(() => expect(useAlerts.getState().alerts.a?.name).toBe('new'));
    expect(api.getAlert).toHaveBeenCalledTimes(1);
    expect(useAlerts.getState().alerts.b).toBeUndefined();
    h.sync.stop();
  });

  it('alert.fired updates the store once and notifies listeners', async () => {
    const h = harness(makeApi());
    await vi.waitFor(() => expect(useAlerts.getState().status).toBe('ready'));
    useAlerts.setState({ alerts: { a: alert('a') } });
    const fn = vi.fn();
    const off = onAlertFired(fn);
    const f = {
      type: 'alert.fired',
      entry: entry(9),
      alert: { id: 'a', status: 'triggered', revision: 2, fireCount: 1, lastFiredAt: 'x' },
    };
    h.frame(f);
    h.frame(f);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(useAlerts.getState()).toMatchObject({ unread: 1 });
    expect(useAlerts.getState().alerts.a).toMatchObject({ status: 'triggered', fireCount: 1 });
    off();
    h.sync.stop();
  });

  it('catches up after a reconnect: announces recent unread fires, counts older ones', async () => {
    const t0 = Date.parse('2026-06-01T12:00:00Z');
    const fresh = entry(11, { firedAt: new Date(t0 - 60_000).toISOString() });
    const old = entry(10, { firedAt: new Date(t0 - 3_600_000).toISOString() });
    let serverUnread = 0;
    const getAlertLog = vi.fn(async (q: { after?: number } = {}) =>
      q.after === undefined
        ? { entries: [entry(8)], hasMore: false, unread: serverUnread }
        : { entries: [fresh, old], hasMore: false, unread: 2 },
    );
    const api = makeApi({ getAlertLog });
    const h = harness(api, () => t0);
    await vi.waitFor(() => expect(useAlerts.getState().status).toBe('ready'));
    const fn = vi.fn();
    const off = onAlertFired(fn);

    h.open(false); // first open: nothing to catch up
    expect(getAlertLog).toHaveBeenCalledTimes(1);
    serverUnread = 2;
    h.open(true);
    // A full reload of alerts runs too; the log was only fetched by the catch-up with `after`.
    await vi.waitFor(() => expect(fn).toHaveBeenCalled());
    expect(getAlertLog).toHaveBeenLastCalledWith({ after: 8, limit: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0].id).toBe(11);
    expect(useAlerts.getState().unread).toBe(2);
    expect(useAlerts.getState().log.map((e) => e.id)).toEqual([11, 10, 8]);
    off();
    h.sync.stop();
  });

  it('catch-up pages back with `before` until `after`, leaving no gap', async () => {
    const mk = (hi: number, lo: number) =>
      Array.from({ length: hi - lo + 1 }, (_, i) => entry(hi - i));
    const getAlertLog = vi.fn(async (q: { after?: number; before?: number } = {}) => {
      if (q.after === undefined) return { entries: [entry(8)], hasMore: false, unread: 0 };
      if (q.before === undefined) return { entries: mk(1208, 709), hasMore: true, unread: 3 };
      if (q.before === 709) return { entries: mk(708, 209), hasMore: true, unread: 3 };
      return { entries: mk(208, 9), hasMore: false, unread: 3 };
    });
    const h = harness(makeApi({ getAlertLog }));
    await vi.waitFor(() => expect(useAlerts.getState().status).toBe('ready'));
    h.open(false);
    h.open(true);
    await vi.waitFor(() => expect(useAlerts.getState().log.length).toBe(1201));
    expect(getAlertLog).toHaveBeenCalledWith({ after: 8, before: 709, limit: 500 });
    expect(getAlertLog).toHaveBeenCalledWith({ after: 8, before: 209, limit: 500 });
    const ids = useAlerts.getState().log.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(1208);
    expect(ids.at(-1)).toBe(8);
    h.sync.stop();
  });
});
