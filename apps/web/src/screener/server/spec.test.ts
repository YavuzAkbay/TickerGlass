import { describe, expect, it } from 'vitest';
import {
  ageOf,
  bannerKind,
  etaOf,
  pollInterval,
  POLL_IDLE_MS,
  POLL_RUNNING_MS,
  screenerMode,
} from './mode';
import { defaultSpec, parseFilter, parseSpec, parseSymbolList, specKey } from './spec';
import type { StatusResponse, StatusRunning } from './types';

const status = (over: Partial<StatusResponse> = {}): StatusResponse => ({
  enabled: true,
  supported: true,
  reason: null,
  provider: 'yahoo',
  asOf: '2026-11-05',
  computedAt: '2026-11-05T22:30:00Z',
  fundamentalsAsOf: null,
  coverage: { tracked: 10, fresh: 10, stale: 0, failed: 0, tombstoned: 0 },
  running: null,
  nextRunAt: null,
  budget: { ratePerMin: 24, tokensLastRun: 0 },
  barsRows: 0,
  ...over,
});

describe('screenerMode', () => {
  it('uses the server only when supported with a finished snapshot', () => {
    expect(screenerMode(null)).toBe('client');
    expect(screenerMode(status())).toBe('server');
    expect(screenerMode(status({ asOf: null, reason: 'first_run' }))).toBe('client');
    expect(screenerMode(status({ supported: false, reason: 'provider_unsupported' }))).toBe(
      'client',
    );
    expect(
      screenerMode(status({ enabled: false, supported: false, reason: 'disabled', asOf: null })),
    ).toBe('client');
  });

  it('stays on the client engine while the first run is going', () => {
    const running: StatusRunning = {
      runId: 1,
      kind: 'snapshot',
      done: 40,
      total: 800,
      startedAt: 'x',
      etaS: 60,
    };
    const first = { running, reason: 'first_run' } as const;
    expect(screenerMode(status({ asOf: null, ...first }))).toBe('client');
    expect(screenerMode(status(first))).toBe('client'); // even with a stray asOf
    expect(bannerKind(status(first))).toBe('first_run');
    // Later runs refresh a server snapshot that already exists: stay on the server.
    expect(screenerMode(status({ running }))).toBe('server');
    expect(screenerMode(status({ reason: 'first_run' }))).toBe('server'); // idle, finished
  });

  it('names the banner state', () => {
    expect(bannerKind(status())).toBe('ready');
    expect(bannerKind(status({ asOf: null, reason: 'first_run' }))).toBe('first_run');
    expect(
      bannerKind(status({ enabled: false, supported: false, asOf: null, reason: 'disabled' })),
    ).toBe('disabled');
    expect(
      bannerKind(status({ supported: false, asOf: null, reason: 'provider_unsupported' })),
    ).toBe('provider_unsupported');
  });

  it('polls every 10 s only while a run is going', () => {
    expect(pollInterval(null)).toBe(POLL_IDLE_MS);
    expect(pollInterval(status())).toBe(POLL_IDLE_MS);
    expect(
      pollInterval(
        status({
          running: { runId: 1, kind: 'snapshot', done: 1, total: 9, startedAt: 'x', etaS: 5 },
        }),
      ),
    ).toBe(POLL_RUNNING_MS);
  });

  it('formats age and eta', () => {
    const now = Date.parse('2026-11-06T00:30:00Z');
    expect(ageOf('2026-11-05T22:30:00Z', now)).toEqual({ key: 'si.agoHour', n: 2 });
    expect(ageOf('2026-11-05T22:25:00Z', now)).toEqual({ key: 'si.agoHour', n: 2 });
    expect(ageOf('2026-11-06T00:20:00Z', now)).toEqual({ key: 'si.agoMin', n: 10 });
    expect(ageOf('2026-11-06T00:29:59Z', now)).toEqual({ key: 'si.agoNow', n: 0 });
    expect(ageOf('2026-11-01T00:30:00Z', now)).toEqual({ key: 'si.agoDay', n: 5 });
    expect(ageOf(null, now)).toBeNull();
    expect(ageOf('nonsense', now)).toBeNull();
    expect(etaOf(30)).toEqual({ key: 'scr.srv.etaSec', n: 30 });
    expect(etaOf(720)).toEqual({ key: 'scr.srv.etaMin', n: 12 });
    expect(etaOf(7200)).toEqual({ key: 'scr.srv.etaHour', n: 2 });
    expect(etaOf(null)).toBeNull();
  });
});

describe('spec parsing', () => {
  it('defaults to the stocks class, unfiltered', () => {
    expect(defaultSpec().universe).toEqual({ kind: 'class', cls: 'stocks' });
    expect(defaultSpec().filter).toBeNull();
  });

  it('parses every universe kind and rejects the rest', () => {
    for (const universe of [
      { kind: 'class', cls: 'crypto' },
      { kind: 'list', id: 'sp500' },
      { kind: 'watchlist', id: 'w1' },
      { kind: 'symbols', symbols: ['AAPL', 'MSFT'] },
    ])
      expect(parseSpec({ universe })?.universe).toEqual(universe);
    expect(parseSpec({ universe: { kind: 'class', cls: 'bonds' } })).toBeNull();
    expect(parseSpec({ universe: { kind: 'list' } })).toBeNull();
    expect(parseSpec(null)).toBeNull();
  });

  it('keeps depth <= 2 and 50 rules of a stored filter', () => {
    const r = { field: 'rsi14', op: '<', value: 30 };
    expect(parseFilter({ op: 'and', rules: [r] })).toEqual({ op: 'and', rules: [r] });
    expect(parseFilter({ op: 'and', rules: [] })).toBeNull();
    const deep = { op: 'and', rules: [{ op: 'or', rules: [{ op: 'and', rules: [r] }] }, r] };
    expect(parseFilter(deep)).toEqual({ op: 'and', rules: [{ op: 'or', rules: [] }, r] });
    const many = { op: 'and', rules: Array.from({ length: 60 }, () => r) };
    expect(parseFilter(many)?.rules).toHaveLength(50);
    expect(
      parseFilter({ op: 'and', rules: [{ field: 'x', op: 'bogus', value: 1 }] })?.rules ?? [],
    ).toHaveLength(0);
  });

  it('compares specs by universe, filter and sort only', () => {
    const a = defaultSpec();
    expect(specKey(a)).toBe(specKey({ ...a, columns: ['name'] }));
    expect(specKey(a)).not.toBe(specKey({ ...a, sort: { field: 'mcap', dir: 'asc' } }));
  });

  it('splits pasted symbols', () => {
    expect(parseSymbolList('aapl, msft\nnvda;aapl  BRK-B  bad$sym')).toEqual([
      'AAPL',
      'MSFT',
      'NVDA',
      'BRK-B',
    ]);
  });
});
