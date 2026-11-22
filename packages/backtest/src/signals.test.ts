import { describe, expect, it } from 'vitest';
import { newStrategy, parseStrategies, parseStrategy } from './parse';
import { buildSignals, strategyOperands } from './signals';
import type { BacktestBars, IndicatorOperand, Strategy } from './types';

const closes = [10, 11, 12, 11, 9, 8, 10, 13];
const b: BacktestBars = {
  length: closes.length,
  time: closes.map((_, i) => i * 60),
  open: closes,
  high: closes.map((c) => c + 1),
  low: closes.map((c) => c - 1),
  close: closes,
};

const ind = (outputId: string): IndicatorOperand => ({
  kind: 'indicator',
  instanceId: 'i1',
  type: 'sma',
  inputs: { length: 3 },
  outputId,
  title: 'SMA 3',
});

const strat = (patch: Partial<Strategy>): Strategy => ({ ...newStrategy('s', 'S'), ...patch });

describe('buildSignals', () => {
  it('evaluates crossings like alerts (previous <= 0 < current)', () => {
    const s = strat({
      longEntry: {
        match: 'all',
        conditions: [
          {
            kind: 'compare',
            left: { kind: 'price', field: 'close' },
            op: 'crossingUp',
            right: { kind: 'value', value: 10.5 },
          },
        ],
      },
    });
    const { signals } = buildSignals(s, b, () => null);
    expect(Array.from(signals.longEntry)).toEqual([0, 1, 0, 0, 0, 0, 0, 1]);
  });

  it('joins conditions with all / any', () => {
    const above = {
      kind: 'compare' as const,
      left: { kind: 'price' as const, field: 'close' as const },
      op: 'greater' as const,
      right: { kind: 'value' as const, value: 10 },
    };
    const below = { ...above, op: 'less' as const, right: { kind: 'value' as const, value: 12 } };
    const all = buildSignals(
      strat({ longEntry: { match: 'all', conditions: [above, below] } }),
      b,
      () => null,
    );
    expect(Array.from(all.signals.longEntry)).toEqual([0, 1, 0, 1, 0, 0, 0, 0]);
    const any = buildSignals(
      strat({ longEntry: { match: 'any', conditions: [above, below] } }),
      b,
      () => null,
    );
    expect(Array.from(any.signals.longEntry)).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('reads indicator series and fires signal conditions on finite values', () => {
    const marks = [NaN, NaN, 1, NaN, NaN, 2, NaN, NaN];
    const s = strat({
      longEntry: { match: 'all', conditions: [{ kind: 'signal', left: ind('up') }] },
    });
    const { signals, missing } = buildSignals(s, b, (op) => (op.outputId === 'up' ? marks : null));
    expect(Array.from(signals.longEntry)).toEqual([0, 0, 1, 0, 0, 1, 0, 0]);
    expect(missing).toEqual([]);
  });

  it('reports missing indicators and never fires on them', () => {
    const s = strat({
      longExit: { match: 'any', conditions: [{ kind: 'signal', left: ind('x') }] },
    });
    const { signals, missing } = buildSignals(s, b, () => null);
    expect(Array.from(signals.longExit).every((v) => v === 0)).toBe(true);
    expect(missing.map((m) => m.outputId)).toEqual(['x']);
  });

  it('moving conditions compare with N bars back', () => {
    const s = strat({
      shortEntry: {
        match: 'all',
        conditions: [
          {
            kind: 'moving',
            left: { kind: 'price', field: 'close' },
            op: 'movingDown',
            amount: 2,
            bars: 2,
          },
        ],
      },
    });
    const { signals } = buildSignals(s, b, () => null);
    // close[4]=9 vs close[2]=12 (3 down), close[5]=8 vs close[3]=11 (3 down).
    expect(Array.from(signals.shortEntry)).toEqual([0, 0, 0, 0, 1, 1, 0, 0]);
  });

  it('lists the indicator operands once', () => {
    const s = strat({
      longEntry: {
        match: 'all',
        conditions: [{ kind: 'compare', left: ind('a'), op: 'greater', right: ind('a') }],
      },
      longExit: { match: 'all', conditions: [{ kind: 'signal', left: ind('b') }] },
    });
    expect(strategyOperands(s).map((o) => o.outputId)).toEqual(['a', 'b']);
  });
});

describe('parseStrategy', () => {
  it('round-trips a valid strategy', () => {
    const s = strat({
      longEntry: { match: 'any', conditions: [{ kind: 'signal', left: ind('up') }] },
    });
    expect(parseStrategy(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('drops invalid conditions and repairs settings', () => {
    const s = parseStrategy({
      id: 'x',
      name: 'X',
      longEntry: {
        match: 'all',
        conditions: [
          {
            kind: 'compare',
            left: { kind: 'price', field: 'nope' },
            op: 'greater',
            right: { kind: 'value', value: 1 },
          },
          { kind: 'bogus' },
        ],
      },
      settings: {
        initialCapital: -5,
        slippagePct: 1000,
        fillAt: 'close',
        sizing: { mode: 'fixedQty', value: 3 },
      },
    });
    expect(s?.longEntry.conditions).toEqual([]);
    expect(s?.settings.initialCapital).toBe(10_000);
    expect(s?.settings.slippagePct).toBe(0);
    expect(s?.settings.fillAt).toBe('close');
    expect(s?.settings.sizing).toEqual({ mode: 'fixedQty', value: 3 });
  });

  it('rejects entries without id / name and de-duplicates ids', () => {
    const ok = newStrategy('a', 'A');
    expect(
      parseStrategies([ok, { name: 'no id' }, { ...ok, name: 'dup' }, 5]).map((s) => s.name),
    ).toEqual(['A']);
  });
});
