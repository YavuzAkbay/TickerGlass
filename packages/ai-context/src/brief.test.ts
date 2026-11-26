import { describe, expect, it } from 'vitest';
import { BRIEF_END, BRIEF_START, buildChartBrief } from './brief';
import { fmtCompact, fmtValue, inferPrecision, isIntraday, timeFormatter } from './format';
import { atrAt, focusStats, rangeIndexes } from './stats';
import type { BriefBars, BriefInput } from './types';

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 5) / 1000; // Monday 2026-01-05 00:00 UTC

/** Daily bars from closes; open = previous close, high/low 1 above/below. */
function bars(closes: number[], step = DAY, volume = 1_000_000): BriefBars {
  return {
    length: closes.length,
    time: closes.map((_, i) => T0 + i * step),
    open: closes.map((c, i) => closes[i - 1] ?? c),
    high: closes.map((c, i) => Math.max(c, closes[i - 1] ?? c) + 1),
    low: closes.map((c, i) => Math.min(c, closes[i - 1] ?? c) - 1),
    close: closes,
    volume: closes.map(() => volume),
  };
}

function input(b: BriefBars, extra: Partial<BriefInput> = {}): BriefInput {
  return {
    symbol: 'AAPL',
    name: 'Apple, Inc.',
    interval: '1D',
    timezone: 'UTC',
    bars: b,
    focus: { kind: 'visible', from: b.time[0] as number, to: b.time[b.length - 1] as number },
    ...extra,
  };
}

const ramp = (n: number, start = 100, step = 1): number[] =>
  Array.from({ length: n }, (_, i) => start + i * step);

describe('format', () => {
  it('formats compact numbers and values', () => {
    expect(fmtCompact(52_100_000)).toBe('52.1M');
    expect(fmtCompact(1_000)).toBe('1K');
    expect(fmtCompact(812)).toBe('812');
    expect(fmtValue(61.234567)).toBe('61.235');
    expect(fmtValue(0.000123456)).toBe('0.00012346');
    expect(fmtValue(NaN)).toBe('');
    expect(fmtValue(2)).toBe('2');
  });

  it('infers price precision', () => {
    expect(inferPrecision([150.1, 151])).toBe(2);
    expect(inferPrecision([0.5123])).toBe(4);
    expect(inferPrecision([0.00001234])).toBe(8);
  });

  it('formats times in the chart timezone', () => {
    expect(timeFormatter('UTC', false)(T0)).toBe('2026-01-05');
    expect(timeFormatter('America/New_York', true)(T0 + 14.5 * 3600)).toBe('2026-01-05 09:30');
    expect(timeFormatter('Not/AZone', false)(T0)).toBe('2026-01-05');
    expect(isIntraday(bars(ramp(10)).time)).toBe(false);
    expect(isIntraday(bars(ramp(10), 300).time)).toBe(true);
  });
});

describe('stats', () => {
  it('finds the inclusive index range', () => {
    const b = bars(ramp(10));
    expect(rangeIndexes(b, T0 + 2 * DAY, T0 + 4 * DAY)).toEqual([2, 4]);
    expect(rangeIndexes(b, T0 + 4 * DAY + 1, T0 + 2 * DAY - 1)).toEqual([2, 4]); // reversed
    expect(rangeIndexes(b, T0 + 2.2 * DAY, T0 + 2.8 * DAY)).toBeNull();
    expect(rangeIndexes(b, T0 + 100 * DAY, T0 + 200 * DAY)).toBeNull();
  });

  it('computes change, extremes and trend', () => {
    const b = bars([100, 102, 101, 105, 103, 108, 107, 110]);
    const s = focusStats(b, 2, 7);
    expect(s.bars).toBe(6);
    expect(s.open).toBe(102);
    expect(s.close).toBe(110);
    expect(s.changePct).toBeCloseTo(7.843, 2);
    expect(s.high).toEqual({ time: T0 + 7 * DAY, price: 111 });
    expect(s.low).toEqual({ time: T0 + 2 * DAY, price: 100 });
    expect(s.upBars).toBe(3);
    expect(s.downBars).toBe(3);
    expect(s.largestUpPct).toBeCloseTo(4.854, 2); // 103 -> 108
    expect(s.largestDownPct).toBeCloseTo(-1.905, 2); // 105 -> 103
    expect(s.slope).toBeGreaterThan(0);
    expect(s.volumeVsPrior).toBeCloseTo(1);
    expect(s.priorChangePct).toBeCloseTo(2); // bars 0..1 (5-bar lead clamps to what exists)
    expect(s.barsAfter).toBe(0);
    expect(s.afterChangePct).toBeNull();
  });

  it('reports what happened after the focus', () => {
    const s = focusStats(bars(ramp(20)), 0, 9);
    expect(s.barsAfter).toBe(10);
    expect(s.afterChangePct).toBeCloseTo((119 / 109 - 1) * 100);
    expect(s.priorChangePct).toBeNull();
  });

  it('finds swing highs and lows', () => {
    const zig = [10, 11, 12, 13, 12, 11, 10, 9, 10, 11, 12, 11, 10, 9, 8, 9, 10, 11];
    const s = focusStats(bars(zig), 0, zig.length - 1);
    expect(s.swingHighs.map((p) => p.price)).toEqual([14, 13]);
    expect(s.swingLows.map((p) => p.price)).toEqual([8, 7]);
  });

  it('computes Wilder ATR', () => {
    const b = bars(ramp(40)); // every true range is 3 (high-low of 3, gap-free)
    expect(atrAt(b, 39)).toBeCloseTo(3);
    expect(atrAt(b, 5)).toBeNull();
  });
});

describe('buildChartBrief', () => {
  it('builds a readable block', () => {
    const b = bars(ramp(60));
    const rsi = Float64Array.from(b.close as number[], (_, i) => (i < 14 ? NaN : 50 + i / 10));
    const brief = buildChartBrief(
      input(b, {
        focus: { kind: 'selection', from: T0 + 40 * DAY, to: T0 + 49 * DAY },
        studies: [{ title: 'RSI 14', outputs: [{ name: 'RSI', values: rsi }] }],
        drawings: [
          {
            type: 'trend-line',
            points: [
              { time: T0 + 41 * DAY, price: 141 },
              { time: T0 + 48 * DAY, price: 148.5 },
            ],
            text: 'my, line',
          },
          { type: 'horizontal-line', points: [{ time: T0, price: 150 }] },
          {
            type: 'trend-line',
            points: [
              { time: T0, price: 1 },
              { time: T0 + DAY, price: 2 },
            ],
          }, // far before
        ],
      }),
      { leadBars: 20 },
    );
    const t = brief.text;
    expect(t.startsWith(BRIEF_START)).toBe(true);
    expect(t.endsWith(BRIEF_END)).toBe(true);
    expect(t).toContain('Symbol: AAPL (Apple Inc.); interval: 1D; times in UTC');
    expect(t).toContain('Focus: user selection 2026-02-14 to 2026-02-23 (10 bars)');
    expect(t).toContain('After the focus: 10 more bars on the chart');
    expect(t).toContain('BEFORE FOCUS (20 bars)');
    expect(t).toContain('time,open,high,low,close,volume,RSI 14');
    expect(t).toContain('2026-02-14,139.00,141.00,138.00,140.00,1M,54');
    expect(t).toContain('RSI 14: 54.9');
    expect(t).toContain('- trend-line: 2026-02-15 141.00 -> 2026-02-22 148.50 "my line"');
    expect(t).toContain('- horizontal-line: 150.00');
    expect(t).not.toContain('2026-01-06 2.00');
    expect(brief.focusBars).toBe(10);
    expect(brief.focusBucket).toBe(1);
    expect(brief.trimmed).toEqual([]);
    expect(brief.stats?.close).toBe(149);
  });

  it('labels multi-output studies by output', () => {
    const b = bars(ramp(5));
    const v = new Float64Array(5).fill(1.5);
    const brief = buildChartBrief(
      input(b, {
        studies: [
          {
            title: 'MACD 12 26 9',
            outputs: [
              { name: 'MACD', values: v },
              { name: 'Signal', values: v },
            ],
          },
        ],
      }),
    );
    expect(brief.text).toContain('volume,MACD 12 26 9: MACD,MACD 12 26 9: Signal');
  });

  it('aggregates long focus ranges', () => {
    const b = bars(ramp(1000));
    const brief = buildChartBrief(input(b), { maxTokens: 1e9 });
    expect(brief.focusBucket).toBe(4); // 1000 / 250
    expect(brief.text).toContain('FOCUS BARS (1000 bars, 4 bars per row');
    expect(brief.text).toContain('2026-01-05,100.00,104.00,99.00,103.00,4M');
  });

  it('shrinks to fit the token budget', () => {
    const b = bars(ramp(400));
    const big = buildChartBrief(input(b), { maxTokens: 1e9 });
    const small = buildChartBrief(input(b), { maxTokens: 1500 });
    expect(small.approxTokens).toBeLessThanOrEqual(1500);
    expect(small.approxTokens).toBeLessThan(big.approxTokens);
    expect(small.trimmed.length).toBeGreaterThan(0);
    expect(small.text).toContain('FOCUS STATS'); // stats always kept
  });

  it('shortens freehand drawings', () => {
    const b = bars(ramp(30));
    const points = Array.from({ length: 50 }, (_, i) => ({
      time: T0 + (i % 30) * DAY,
      price: 100 + i,
    }));
    const brief = buildChartBrief(input(b, { drawings: [{ type: 'brush', points }] }));
    expect(brief.text).toContain('- brush: 2026-01-05 100.00 -> 2026-01-24 149.00 (50 points)');
  });

  it('adds header notes', () => {
    const brief = buildChartBrief(input(bars(ramp(5)), { notes: ['Heikin Ashi bars'] }));
    expect(brief.text).toContain('Note: Heikin Ashi bars\n\nFOCUS STATS');
  });

  it('handles an empty focus', () => {
    const b = bars(ramp(5));
    const brief = buildChartBrief(input(b, { focus: { kind: 'selection', from: 0, to: 1 } }));
    expect(brief.stats).toBeNull();
    expect(brief.text).toContain('No bars in the focus range.');
  });

  it('copes with zero volume and gaps in indicator values', () => {
    const b = bars(ramp(30), DAY, 0);
    const brief = buildChartBrief(
      input(b, {
        studies: [
          { title: 'SMA 50', outputs: [{ name: 'SMA', values: new Float64Array(30).fill(NaN) }] },
        ],
      }),
    );
    expect(brief.text).not.toContain('Average volume');
    expect(brief.text).toContain('SMA 50: no value');
    expect(brief.text).not.toContain('NaN');
  });
});
