import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAlertEvaluator, type SeedContext } from './evaluator';
import type { AlertRuntimeState, AlertSpec, Sample } from './types';

const CASES = join(import.meta.dirname, '../test/fixtures/cases');

interface Expected {
  at: number;
  final?: boolean;
  delayed?: boolean;
}

interface Case {
  name: string;
  spec: AlertSpec;
  alert?: { expiresAt?: string | null; updatedAt?: string; interval?: string };
  seed?: { state: AlertRuntimeState | null; ctx: SeedContext };
  expectSeed?: { final: boolean; delayed: boolean; barTime: number } | null;
  samples: Sample[];
  expect: (number | Expected)[];
}

const files = readdirSync(CASES).filter((f) => f.endsWith('.json'));

/** JSON null stands for NaN in sample values. */
function revive(s: Sample): Sample {
  const values = Object.fromEntries(
    Object.entries(s.values).map(([k, v]) => [k, v === null ? NaN : v]),
  ) as unknown as Sample['values'];
  return { ...s, values };
}

describe.each(files)('golden cases %s', (file) => {
  const { cases } = JSON.parse(readFileSync(join(CASES, file), 'utf8')) as { cases: Case[] };
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const ev = createAlertEvaluator({
      symbol: 'TEST',
      interval: c.alert?.interval ?? '1m',
      prepost: false,
      spec: c.spec,
      expiresAt: c.alert?.expiresAt ?? null,
      ...(c.alert?.updatedAt ? { updatedAt: c.alert.updatedAt } : {}),
    });
    if (c.seed) {
      const d = ev.seed(c.seed.state, c.seed.ctx);
      if (c.expectSeed === undefined || c.expectSeed === null) expect(d).toBeNull();
      else {
        expect(d).not.toBeNull();
        expect({ final: d?.final, delayed: d?.delayed, barTime: d?.barTime }).toEqual(c.expectSeed);
      }
    }
    const fires: Expected[] = [];
    c.samples.forEach((s, i) => {
      const d = ev.onSample(revive(s));
      if (d) fires.push({ at: i, final: d.final, delayed: d.delayed });
    });
    const want = c.expect.map((e) => (typeof e === 'number' ? { at: e } : e));
    expect(fires.map((f) => f.at)).toEqual(want.map((w) => w.at));
    want.forEach((w, k) => {
      if (w.final !== undefined) expect(fires[k]?.final).toBe(w.final);
      if (w.delayed !== undefined) expect(fires[k]?.delayed).toBe(w.delayed);
    });
  });
});

const crossUp: AlertSpec = {
  schemaVersion: 1,
  left: { kind: 'price', field: 'close' },
  condition: { op: 'crossingUp', right: { kind: 'value', value: 10 } },
  trigger: 'oncePerBar',
};

const v = (x: number) => ({ x, y: 10, open: x, high: x, low: x, close: x, volume: 0 });

describe('evaluator state', () => {
  it('round-trips through JSON and restores prev for the same series', () => {
    const a = createAlertEvaluator({
      symbol: 'AAPL',
      interval: '5m',
      prepost: true,
      spec: crossUp,
      expiresAt: null,
    });
    expect(a.seriesKey).toBe('AAPL|5m|prepost');
    a.onSample({ kind: 'tick', barIndex: 3, barTime: 900, now: 1, values: v(9) });
    const st = JSON.parse(JSON.stringify(a.state())) as AlertRuntimeState;
    expect(st).toEqual({
      v: 1,
      seriesKey: 'AAPL|5m|prepost',
      prev: { barTime: 900, kind: 'tick', values: v(9) },
      lastFiredBarTime: null,
      lastFiredAt: null,
      lastClosedBarTime: null,
    });
    const b = createAlertEvaluator({
      symbol: 'AAPL',
      interval: '5m',
      prepost: true,
      spec: crossUp,
      expiresAt: null,
    });
    expect(b.seed(st, { now: 2, lastBarTime: 900, previousBarTime: 600 })).toBeNull();
    const d = b.onSample({ kind: 'tick', barIndex: 3, barTime: 900, now: 3, values: v(11) });
    expect(d).toMatchObject({ fire: true, final: false, delayed: false, barTime: 900, firedAt: 3 });
    expect(b.state()).toMatchObject({ lastFiredBarTime: 900, lastFiredAt: 3 });
  });

  it('once: done after the fire; isExpired follows expiresAt', () => {
    const ev = createAlertEvaluator({
      symbol: 'X',
      interval: '1D',
      prepost: false,
      spec: {
        ...crossUp,
        trigger: 'once',
        condition: { op: 'greater', right: { kind: 'value', value: 10 } },
      },
      expiresAt: '2026-01-01T00:00:00Z',
    });
    expect(ev.done).toBe(false);
    expect(
      ev.onSample({ kind: 'tick', barIndex: 0, barTime: 0, now: 0, values: v(11) })?.final,
    ).toBe(true);
    expect(ev.done).toBe(true);
    expect(ev.isExpired(Date.parse('2025-12-31T23:59:59Z'))).toBe(false);
    expect(ev.isExpired(Date.parse('2026-01-01T00:00:00Z'))).toBe(true);
  });

  it('once: a fired alert stays done across a re-seed (history reload)', () => {
    const ev = createAlertEvaluator({
      symbol: 'X',
      interval: '1D',
      prepost: false,
      spec: {
        ...crossUp,
        trigger: 'once',
        condition: { op: 'greater', right: { kind: 'value', value: 10 } },
      },
      expiresAt: null,
    });
    const ctx = { now: 1, lastBarTime: 0, previousBarTime: null };
    ev.seed(null, ctx);
    expect(
      ev.onSample({ kind: 'tick', barIndex: 0, barTime: 0, now: 1, values: v(11) })?.final,
    ).toBe(true);
    expect(ev.done).toBe(true);
    ev.seed(ev.state(), ctx);
    expect(ev.done).toBe(true);
    expect(
      ev.onSample({ kind: 'tick', barIndex: 0, barTime: 0, now: 2, values: v(12) }),
    ).toBeNull();
  });

  it('delayed uses max(120 s, 1 interval)', () => {
    const mk = (interval: string) =>
      createAlertEvaluator({
        symbol: 'X',
        interval,
        prepost: false,
        spec: {
          ...crossUp,
          trigger: 'everyTime',
          condition: { op: 'greater', right: { kind: 'value', value: 10 } },
        },
        expiresAt: null,
      });
    const s = (now: number, eventAt: number): Sample => ({
      kind: 'close',
      barIndex: 0,
      barTime: 0,
      now,
      eventAt,
      values: v(11),
    });
    expect(mk('1m').onSample(s(120_001, 0))?.delayed).toBe(true);
    expect(mk('1m').onSample(s(120_000, 0))?.delayed).toBe(false);
    expect(mk('5m').onSample(s(300_000, 0))?.delayed).toBe(false);
    expect(mk('5m').onSample(s(300_001, 0))?.delayed).toBe(true);
  });

  it('rejects an unparsable expiresAt', () => {
    expect(() =>
      createAlertEvaluator({
        symbol: 'X',
        interval: '1m',
        prepost: false,
        spec: crossUp,
        expiresAt: 'soon',
      }),
    ).toThrow(/expiresAt/);
  });
});
