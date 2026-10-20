import { describe, expect, it } from 'vitest';
import { upgradeAlertSpec } from './legacy';
import { validateAlert } from './validate';

const ind = (type: string) => ({
  kind: 'indicator',
  ref: {
    instances: [{ id: 'a', type, inputs: {} }],
    instanceId: 'a',
    outputId: 'x',
    title: 't',
  },
});

describe('upgradeAlertSpec', () => {
  it('maps legacy ids in left, right and channel bounds', () => {
    const spec = {
      schemaVersion: 1,
      left: ind('relative-volume'),
      condition: {
        op: 'enteringChannel',
        channel: { kind: 'bounds', upper: ind('auto-fib'), lower: ind('pivots-hl') },
      },
      trigger: 'once',
    };
    const out = upgradeAlertSpec(spec) as typeof spec;
    expect((out.left as ReturnType<typeof ind>).ref.instances[0]!.type).toBe('tod-relative-volume');
    const ch = out.condition.channel as {
      upper: ReturnType<typeof ind>;
      lower: ReturnType<typeof ind>;
    };
    expect(ch.upper.ref.instances[0]!.type).toBe('swing-fib');
    expect(ch.lower.ref.instances[0]!.type).toBe('swing-hl');
    // input is not mutated
    expect(spec.left.ref.instances[0]!.type).toBe('relative-volume');
  });

  it('maps a cross-condition right operand and keeps current ids', () => {
    const spec = {
      left: ind('sma'),
      condition: { op: 'crossing', right: ind('relative-volume') },
    };
    const out = upgradeAlertSpec(spec) as typeof spec;
    expect(out.left.ref.instances[0]!.type).toBe('sma');
    expect((out.condition.right as ReturnType<typeof ind>).ref.instances[0]!.type).toBe(
      'tod-relative-volume',
    );
  });

  it('passes through non-objects and malformed specs', () => {
    expect(upgradeAlertSpec(null)).toBeNull();
    expect(upgradeAlertSpec('x')).toBe('x');
    expect(upgradeAlertSpec({ left: 3 })).toEqual({ left: 3 });
  });

  it('validateAlert accepts a legacy id and stores the new one', () => {
    const body = {
      name: 'n',
      symbol: 'AAPL',
      interval: '1D',
      spec: {
        schemaVersion: 1,
        left: ind('sma'),
        condition: { op: 'greater', right: { kind: 'value', value: 1 } },
        trigger: 'once',
      },
    };
    const legacy = structuredClone(body);
    legacy.spec.left = ind('relative-volume') as never;
    legacy.spec.left.ref.instances[0]!.type = 'relative-volume';
    legacy.spec.left.ref.outputId = 'rvol';
    const r = validateAlert(legacy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const left = r.alert.spec.left as ReturnType<typeof ind>;
      expect(left.ref.instances[0]!.type).toBe('tod-relative-volume');
    }
  });
});
