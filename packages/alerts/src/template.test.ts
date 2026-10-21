import { describe, expect, it } from 'vitest';
import { renderMessage, truncateMessage, type MessageContext } from './template';
import type { AlertSpec, SampleValues } from './types';

const values: SampleValues = {
  x: 190.1234,
  y: 190,
  open: 189.5,
  high: 190.5,
  low: 189.25,
  close: 190.1234,
  volume: 1234567.6,
};

const spec: AlertSpec = {
  schemaVersion: 1,
  left: { kind: 'price', field: 'close' },
  condition: { op: 'crossingUp', right: { kind: 'value', value: 190 } },
  trigger: 'once',
};

const ctx = (over: Partial<MessageContext> = {}): MessageContext => ({
  alert: { name: 'My alert', symbol: 'AAPL', interval: '5m', spec },
  symbol: { exchange: 'NMS', currency: 'USD', priceHint: 2 },
  barTime: Date.UTC(2026, 9, 15, 14, 30) / 1000,
  values,
  firedAt: Date.UTC(2026, 9, 15, 14, 32, 5, 789),
  ...over,
});

describe('renderMessage', () => {
  it('fills every placeholder', () => {
    const tpl =
      '{{ticker}}|{{exchange}}|{{currency}}|{{interval}}|{{open}}|{{high}}|{{low}}|{{close}}|' +
      '{{volume}}|{{price}}|{{value}}|{{target}}|{{upper}}|{{lower}}|{{change}}|{{time}}|' +
      '{{timenow}}|{{name}}|{{condition}}';
    expect(renderMessage(tpl, ctx())).toBe(
      'AAPL|NMS|USD|5m|189.50|190.50|189.25|190.12|1234568|190.12|190.12|190.00||||' +
        '2026-10-15T14:30:00Z|2026-10-15T14:32:05Z|My alert|Crossing Up 190.00',
    );
  });

  it("'' renders the default template", () => {
    expect(renderMessage('', ctx())).toBe('AAPL Crossing Up 190.00');
  });

  it('keeps unknown placeholders and unclosed {{ literally', () => {
    expect(renderMessage('{{nope}} {{close', ctx())).toBe('{{nope}} {{close');
    expect(renderMessage('{{ close }} {{{{close}}}}', ctx())).toBe('{{ close }} {{190.12}}');
    expect(renderMessage('{{toString}} {{constructor}}', ctx())).toBe(
      '{{toString}} {{constructor}}',
    );
    expect(renderMessage('a }} b {{', ctx())).toBe('a }} b {{');
  });

  it('truncates at 2000 characters with …', () => {
    const long = 'x'.repeat(1990) + '{{name}}';
    const out = renderMessage(long, ctx({ alert: { ...ctx().alert, name: 'n'.repeat(50) } }));
    expect(Array.from(out)).toHaveLength(2000);
    expect(out.endsWith('…')).toBe(true);
    expect(renderMessage('x'.repeat(2000), ctx())).toBe('x'.repeat(2000));
    // Code points, not UTF-16 units.
    expect(Array.from(truncateMessage('😀'.repeat(2001)))).toHaveLength(2000);
  });

  it('uses the price hint for prices and unknown symbol fields render empty', () => {
    const c = ctx({ symbol: { exchange: null, priceHint: 4 } });
    expect(renderMessage('{{close}} {{value}} {{target}} [{{exchange}}{{currency}}]', c)).toBe(
      '190.1234 190.1234 190.0000 []',
    );
    expect(renderMessage('{{close}}', ctx({ symbol: null }))).toBe('190.12');
  });

  it('indicator values use the definition precision, else 2 decimals beyond the price hint', () => {
    const rsi: AlertSpec = {
      ...spec,
      left: {
        kind: 'indicator',
        ref: {
          instances: [{ id: 'r', type: 'rsi', inputs: { length: 14 } }],
          instanceId: 'r',
          outputId: 'rsi',
          title: 'RSI 14 close',
        },
      },
      condition: { op: 'crossingUp', right: { kind: 'value', value: 70 } },
    };
    const v = { ...values, x: 70.12345, y: 70 };
    const c = ctx({ alert: { ...ctx().alert, spec: rsi }, values: v });
    expect(renderMessage('{{value}} {{target}} {{condition}}', c)).toBe(
      '70.12 70.00 RSI 14 close Crossing Up 70.00',
    );
    const ema: AlertSpec = {
      ...spec,
      condition: {
        op: 'greater',
        right: {
          kind: 'indicator',
          ref: {
            instances: [{ id: 'e', type: 'ema', inputs: { length: 9 } }],
            instanceId: 'e',
            outputId: 'ema',
            title: 'EMA 9 close',
          },
        },
      },
    };
    const c2 = ctx({ alert: { ...ctx().alert, spec: ema }, values: { ...values, y: 189.98765 } });
    expect(renderMessage('{{value}} {{target}}', c2)).toBe('190.12 189.9877');
  });

  it('channels: target lower–upper, upper, lower', () => {
    const ch: AlertSpec = {
      ...spec,
      condition: {
        op: 'enteringChannel',
        channel: {
          kind: 'bounds',
          upper: { kind: 'value', value: 11 },
          lower: { kind: 'value', value: 9 },
        },
      },
    };
    const c = ctx({
      alert: { ...ctx().alert, spec: ch },
      values: { ...values, x: 10, upper: 11, lower: 9 },
    });
    expect(renderMessage('{{target}} {{upper}} {{lower}} {{change}}', c)).toBe(
      '9.00–11.00 11.00 9.00 ',
    );
  });

  it('moving: target amount (with %), change x - ref or percent', () => {
    const mv = (op: 'movingUp' | 'movingUpPercent'): MessageContext =>
      ctx({
        alert: { ...ctx().alert, spec: { ...spec, condition: { op, amount: 5, bars: 2 } } },
        values: { ...values, x: 105, ref: 100 },
      });
    expect(renderMessage('{{target}} {{change}}', mv('movingUp'))).toBe('5.00 5.00');
    expect(renderMessage('{{target}} {{change}}', mv('movingUpPercent'))).toBe('5.00% 5.00%');
    expect(renderMessage('{{condition}}', mv('movingUpPercent'))).toBe('Moving Up 5% in 2 bars');
  });

  it('invalid values render empty', () => {
    expect(renderMessage('[{{value}}]', ctx({ values: { ...values, x: NaN } }))).toBe('[]');
  });
});
