import { describe, expect, it } from 'vitest';
import { ApiClient, ApiError } from './api';
import { ConfigError, deriveWsUrl, loadConfig } from './config';
import { hashInstances } from './operands';
import { Registry } from './registry';
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
  it('does not send the token on read routes', async () => {
    const seen: (string | null)[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('x-alerts-token'));
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;
    await new ApiClient({ baseUrl: 'http://x', token: 'tok', fetchImpl }).listAlerts();
    expect(seen).toEqual([null]);
  });
});
