import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from './api';
import { ConfigError, deriveWsUrl, loadConfig } from './config';
import { hashInstances } from './operands';
import { Registry } from './registry';
import { StateStore } from './state';
import type { AlertRuntimeState } from '@tickerglass/alerts';
import { resolveTimeframe } from './series';
import { makeAlert } from './test-utils';

describe('config', () => {
  it('has defaults', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({
      apiUrl: 'http://localhost:8000',
      wsUrl: 'ws://localhost:8000/ws',
      pollMs: 30_000,
      closeGraceS: 60,
      minRefireS: 60,
      stateFlushMs: 5000,
      shutdownMs: 8000,
      maxBars: 5000,
      maxDrawingBars: 20_000,
      logLevel: 'info',
      token: null,
    });
  });
  it('rejects invalid values', () => {
    expect(() => loadConfig({ ALERTS_POLL_MS: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ ALERTS_LOG_LEVEL: 'loud' })).toThrow(ConfigError);
    expect(() => loadConfig({ API_URL: 'not a url' })).toThrow(ConfigError);
  });
  it('keeps the token out of the socket URL', () => {
    const c = loadConfig({ ALERTS_INTERNAL_TOKEN: 'secret-token-value' });
    expect(c.token).toBe('secret-token-value');
    expect(c.wsUrl).toBe('ws://localhost:8000/ws');
  });
  it('derives wss for https', () => {
    expect(deriveWsUrl('https://x.example/base')).toBe('wss://x.example/ws');
  });
});

describe('registry', () => {
  it('diffs added, changed and removed', () => {
    const r = new Registry();
    const a = makeAlert({ id: 'a' });
    const b = makeAlert({ id: 'b' });
    expect(r.apply([a, b]).added.map((x) => x.id)).toEqual(['a', 'b']);
    const d = r.apply([
      { ...a, revision: 2 },
      { ...b, fireCount: 5 },
    ]);
    expect(d.changed.map((x) => x.id)).toEqual(['a']);
    expect(d.added).toHaveLength(0);
    expect(r.apply([b]).removed.map((x) => x.id)).toEqual(['a']);
  });
});

describe('operands', () => {
  it('hashes identical instances equally and chains upstream hashes', () => {
    const ref = (id: string, len: number) => ({
      instances: [
        { id, type: 'sma', inputs: { length: len, source: 'close' } },
        {
          id: `${id}2`,
          type: 'ema',
          inputs: { length: 5, source: { instanceId: id, outputId: 'ma' } },
        },
      ],
      instanceId: `${id}2`,
      outputId: 'ma',
      title: 't',
    });
    const a = hashInstances(ref('p', 3));
    const b = hashInstances(ref('q', 3));
    const c = hashInstances(ref('r', 4));
    expect(a.get('p2')!.hash).toBe(b.get('q2')!.hash);
    expect(a.get('p2')!.hash).not.toBe(c.get('r2')!.hash);
    expect(a.get('p2')!.inputs['source']).toEqual({ instanceId: a.get('p')!.hash, outputId: 'ma' });
  });
});

describe('timeframes', () => {
  it('resolves auto like the web controller', () => {
    expect(resolveTimeframe('auto', '5m')).toBe('1D');
    expect(resolveTimeframe('auto', '1D')).toBe('1W');
    expect(resolveTimeframe('auto', '1W')).toBe('12M');
    expect(resolveTimeframe('1m', '5m')).toBe('');
    expect(resolveTimeframe('', '5m')).toBe('');
  });
});

describe('api client', () => {
  it('retries transient failures, sends the token, surfaces 409 current', async () => {
    const seen: (string | null)[] = [];
    let n = 0;
    const alert = makeAlert();
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('x-alerts-token'));
      n++;
      if (n === 1) throw new Error('boom');
      if (n === 2) return new Response('', { status: 503 });
      if (n === 3) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ detail: { message: 'changed', current: alert } }), {
        status: 409,
      });
    }) as unknown as typeof fetch;
    const api = new ApiClient({
      baseUrl: 'http://x',
      token: 'tok',
      fetchImpl,
      attempts: 3,
      sleep: async () => {},
    });
    await api.putStates([]);
    expect(n).toBe(3);
    expect(seen).toEqual(['tok', 'tok', 'tok']);
    const err = await api
      .setStatus('a1', { revision: 1, status: 'error', reason: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).current?.id).toBe('a1');
    expect(n).toBe(4); // not retried
  });
  it('sends the token on every GET when configured (API auth would 401 them otherwise)', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('x-alerts-token'));
      const body = _u.endsWith('/api/providers') ? '{"active":"demo"}' : '[]';
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const api = new ApiClient({ baseUrl: 'http://x', token: 'tok', fetchImpl });
    await api.listAlerts();
    await api.listStates();
    await api.listUserScripts();
    await api.activeProvider();
    await api.health();
    expect(seen).toEqual(['tok', 'tok', 'tok', 'tok', 'tok']);
  });
  it('sends no token header when none is configured', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('x-alerts-token'));
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    const api = new ApiClient({ baseUrl: 'http://x', fetchImpl });
    await api.listAlerts();
    await api.heartbeat({} as never);
    expect(seen).toEqual([null, null]);
  });
});

describe('StateStore', () => {
  const st = (n: number) => ({ n }) as unknown as AlertRuntimeState;
  const log = { debug() {}, info() {}, warn() {}, error() {} } as never;

  it('never overlaps flushes: the newer snapshot is written last', async () => {
    const calls: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let releaseFirst!: () => void;
    const first = new Promise<void>((r) => (releaseFirst = r));
    const api = {
      async putStates(rows: { state: AlertRuntimeState }[]) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        calls.push((rows[0]!.state as unknown as { n: number }).n);
        if (calls.length === 1) await first;
        inFlight--;
        return { written: [], ignored: [] };
      },
    };
    const store = new StateStore(api, log);
    store.mark('a', 1, () => st(1));
    const f1 = store.flush();
    await Promise.resolve();
    store.mark('a', 1, () => st(2));
    const f2 = store.flush();
    releaseFirst();
    await Promise.all([f1, f2]);
    expect(maxInFlight).toBe(1);
    expect(calls).toEqual([1, 2]);
    expect(store.size).toBe(0);
  });

  it('drops a chunk rejected with a permanent 4xx and still sends the rest', async () => {
    const sent: number[] = [];
    const api = {
      async putStates(rows: unknown[]) {
        sent.push(rows.length);
        if (sent.length === 1) throw new ApiError('too large', 413);
        return { written: [], ignored: [] };
      },
    };
    const store = new StateStore(api, log);
    for (let i = 0; i < 1500; i++) store.mark(`a${i}`, 1, () => st(i));
    await store.flush();
    expect(sent).toEqual([1000, 500]);
    expect(store.size).toBe(0);
  });

  it('keeps rows dirty on 5xx / 429 / auth / network errors', async () => {
    for (const status of [0, 503, 429, 401, 403, 404]) {
      const api = {
        async putStates(): Promise<never> {
          throw new ApiError('x', status);
        },
      };
      const store = new StateStore(api, log);
      store.mark('a', 1, () => st(1));
      await store.flush();
      expect(store.size).toBe(1);
    }
  });
});
