import { describe, expect, it } from 'vitest';
import { buildIndicatorRef, defaultAlertName, describeCondition } from './describe';
import type { AlertSpec, Condition, SeriesOperand } from './types';

const close: SeriesOperand = { kind: 'price', field: 'close' };
const mk = (condition: Condition, left: SeriesOperand = close) => ({
  spec: { schemaVersion: 1, left, condition, trigger: 'once' } satisfies AlertSpec,
});
const rsi: SeriesOperand = {
  kind: 'indicator',
  ref: {
    instances: [{ id: 'r', type: 'rsi', inputs: {} }],
    instanceId: 'r',
    outputId: 'rsi',
    title: 'RSI 14 close',
  },
};

describe('describeCondition', () => {
  it('describes each condition family', () => {
    expect(describeCondition(mk({ op: 'crossingUp', right: { kind: 'value', value: 190 } }))).toBe(
      'Crossing Up 190.00',
    );
    expect(
      describeCondition(
        mk(
          {
            op: 'enteringChannel',
            channel: { kind: 'drawing', drawingId: 'd1', scale: 'linear' },
          },
          rsi,
        ),
      ),
    ).toBe('RSI 14 close Entering Channel');
    expect(
      describeCondition(
        mk(
          { op: 'greater', right: { kind: 'price', field: 'open' } },
          { kind: 'price', field: 'high' },
        ),
      ),
    ).toBe('High Greater Than Open');
    expect(
      describeCondition(
        mk({
          op: 'outsideChannel',
          channel: {
            kind: 'bounds',
            upper: { kind: 'value', value: 9 },
            lower: { kind: 'value', value: 11 },
          },
        }),
      ),
    ).toBe('Outside Channel 9.00–11.00');
    expect(
      describeCondition(mk({ op: 'movingDown', amount: 2.5, bars: 1 }), { precision: 1 }),
    ).toBe('Moving Down 2.5 in 1 bar');
    expect(describeCondition(mk({ op: 'movingDownPercent', amount: 10, bars: 3 }))).toBe(
      'Moving Down 10% in 3 bars',
    );
    const drawing = mk({
      op: 'crossing',
      right: { kind: 'drawing', drawingId: 'd', part: 'upper', scale: 'log' },
    });
    expect(describeCondition(drawing)).toBe('Crossing Drawing upper');
    expect(describeCondition(drawing, { drawing: () => 'Parallel channel' })).toBe(
      'Crossing Parallel channel upper',
    );
  });

  it('default name prefixes the symbol', () => {
    expect(
      defaultAlertName({
        symbol: 'AAPL',
        ...mk({ op: 'crossing', right: { kind: 'value', value: 190 } }),
      }),
    ).toBe('AAPL Crossing 190.00');
  });
});

describe('buildIndicatorRef', () => {
  const chart = [
    { id: 'rsi1', type: 'rsi', inputs: { length: 21 } },
    {
      id: 'ma1',
      type: 'sma',
      inputs: { length: 10, source: { instanceId: 'rsi1', outputId: 'rsi' } },
    },
    { id: 'bb', type: 'bollinger' },
    { id: 'other', type: 'ema' },
  ];

  it('collects the upstream closure with resolved inputs', () => {
    const ref = buildIndicatorRef(chart, 'ma1', 'ma');
    expect(ref.instanceId).toBe('ma1');
    expect(ref.outputId).toBe('ma');
    expect(ref.instances.map((i) => i.id).sort()).toEqual(['ma1', 'rsi1']);
    const r = ref.instances.find((i) => i.id === 'rsi1');
    expect(r?.inputs['length']).toBe(21);
    expect(r?.inputs['source']).toBe('close');
    expect(ref.title).toBe('SMA 10 RSI: RSI');
  });

  it('titles multi-plot outputs and rejects bad refs', () => {
    expect(buildIndicatorRef(chart, 'bb', 'upper').title).toBe('BB 20 SMA close 2 Upper');
    expect(() => buildIndicatorRef(chart, 'bb', 'background')).toThrow(/not a plot/);
    expect(() => buildIndicatorRef(chart, 'missing', 'x')).toThrow(/not found/);
    expect(() => buildIndicatorRef([{ id: 'a', type: 'nope' }], 'a', 'x')).toThrow(
      /unknown indicator/,
    );
    const cyc = [
      { id: 'a', type: 'sma', inputs: { source: { instanceId: 'b', outputId: 'ma' } } },
      { id: 'b', type: 'sma', inputs: { source: { instanceId: 'a', outputId: 'ma' } } },
    ];
    expect(() => buildIndicatorRef(cyc, 'a', 'ma')).toThrow(/cycle/);
  });
});
