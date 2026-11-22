import { IndicatorRegistry, defaultRegistry } from '@tickerglass/indicators';
import { describe, expect, it } from 'vitest';
import type { UserScript } from '../../api/types';
import { syncScriptDefinitions } from '../../scripts/definitions';
import { formToAlert, formUsesScript, type FormState } from './form';
import {
  REASON_COMPILE,
  REASON_DELETED,
  REASON_REPAINTS,
  REASON_SCRIPT_CHAIN,
  firstOutputId,
  indicatorOperand,
  indicatorOptions,
  leftOptions,
  type AlertContext,
} from './sources';

/** Registry with the built-ins the tests use and script stubs from manifests, like the web's `defaultRegistry`. */
function registryWith(...scripts: { id: string; repaints?: true; outputs?: string[] }[]) {
  const reg = new IndicatorRegistry();
  for (const id of ['sma', 'rsi']) {
    const def = defaultRegistry.get(id);
    if (def) reg.register(def);
  }
  const list: UserScript[] = scripts.map((s) => ({
    id: s.id,
    name: `Script ${s.id}`,
    source: '// script',
    manifest: {
      id: `user:${s.id}`,
      name: `Script ${s.id}`,
      shortName: `S${s.id}`,
      category: 'other',
      overlay: true,
      ...(s.repaints ? { repaints: true } : {}),
      inputs: { length: { kind: 'int', label: 'Length', default: 5, min: 1, max: 50 } },
      outputs: (s.outputs ?? ['v']).map((o) => ({
        type: 'plot',
        id: o,
        title: o.toUpperCase(),
        kind: 'line',
        color: '#6E9BD6',
      })),
    },
    apiVersion: 1,
    revision: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }));
  syncScriptDefinitions(list, reg);
  return reg;
}

const ctx = (o: Partial<AlertContext> = {}): AlertContext => ({
  symbol: 'AAPL',
  interval: '1D',
  prepost: false,
  chartType: 'candles',
  decimals: 2,
  indicators: [],
  paneOf: () => 'main',
  indicatorValue: () => undefined,
  drawings: [],
  scaleOf: () => 'linear',
  lastPrice: () => undefined,
  lastBar: null,
  ...o,
});

describe('script sources in the alert dialog', () => {
  it('offers every plot output of a script instance', () => {
    const registry = registryWith({ id: 'a', outputs: ['fast', 'slow'] });
    const opts = indicatorOptions(ctx({ registry, indicators: [{ id: 'u1', type: 'user:a' }] }));
    expect(opts.map((o) => o.key)).toEqual(['ind:u1:fast', 'ind:u1:slow']);
    expect(opts.every((o) => !o.disabled && o.group === 'Indicators')).toBe(true);
    expect(opts[0]!.operand).toMatchObject({
      kind: 'indicator',
      ref: { instanceId: 'u1', outputId: 'fast', instances: [{ id: 'u1', type: 'user:a' }] },
    });
    expect(firstOutputId('user:a', registry)).toBe('fast');
  });

  it('lists repainting scripts disabled with the reason', () => {
    const registry = registryWith({ id: 'rp', repaints: true });
    const [o] = indicatorOptions(ctx({ registry, indicators: [{ id: 'u1', type: 'user:rp' }] }));
    expect(o?.disabled).toBe(REASON_REPAINTS);
    expect(
      indicatorOperand(ctx({ registry, indicators: [{ id: 'u1', type: 'user:rp' }] }), 'u1', 'v'),
    ).toBeNull();
  });

  it('lists a script without a manifest disabled, and tells a deleted one apart', () => {
    const registry = registryWith();
    const indicators = [{ id: 'u1', type: 'user:broken' }];
    const named = indicatorOptions(ctx({ registry, indicators, scriptName: () => 'My script' }));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ label: 'My script', disabled: REASON_COMPILE });
    const gone = indicatorOptions(ctx({ registry, indicators, scriptName: () => undefined }));
    expect(gone[0]?.disabled).toBe(REASON_DELETED);
  });

  it('lists a built-in computed from a script disabled', () => {
    const registry = registryWith({ id: 'a' });
    const indicators = [
      { id: 'u1', type: 'user:a' },
      { id: 's1', type: 'sma', inputs: { source: { instanceId: 'u1', outputId: 'v' } } },
    ];
    const opts = indicatorOptions(ctx({ registry, indicators }));
    expect(opts.find((o) => o.key === 'ind:u1:v')?.disabled).toBeUndefined();
    expect(opts.find((o) => o.key.startsWith('ind:s1:'))?.disabled).toBe(REASON_SCRIPT_CHAIN);
  });

  it('keeps plain built-ins selectable', () => {
    const registry = registryWith();
    const c = ctx({ registry, indicators: [{ id: 's1', type: 'sma' }] });
    expect(indicatorOptions(c).every((o) => !o.disabled)).toBe(true);
    expect(leftOptions(c, 'AAPL').some((o) => o.key.startsWith('ind:s1:'))).toBe(true);
  });
});

describe('formToAlert with script operands', () => {
  const form = (left: FormState['left']): FormState => ({
    name: '',
    symbol: 'AAPL',
    interval: '1D',
    prepost: false,
    left,
    op: 'greater',
    right: { kind: 'value', text: '10' },
    channel: {
      kind: 'bounds',
      upper: { kind: 'value', text: '' },
      lower: { kind: 'value', text: '' },
    },
    amount: '',
    bars: '1',
    trigger: 'once',
    expiresAt: null,
    message: '',
    notify: {} as FormState['notify'],
    status: 'active',
  });

  it('validates a script operand against the combined registry', () => {
    const registry = registryWith({ id: 'a' });
    const c = ctx({ registry, indicators: [{ id: 'u1', type: 'user:a' }] });
    const left = indicatorOperand(c, 'u1', 'v')!;
    const f = form(left);
    expect(formUsesScript(f)).toBe(true);
    expect(formUsesScript(form({ kind: 'price', field: 'close' }))).toBe(false);
    expect(formToAlert(f, { registry }).ok).toBe(true);
    // Without the stubs the type is unknown.
    const bare = formToAlert(f, { registry: new IndicatorRegistry() });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.errors.map((e) => e.code)).toContain('unknown_indicator');
  });

  it('refuses a repainting script', () => {
    const registry = registryWith({ id: 'rp', repaints: true });
    const left = {
      kind: 'indicator' as const,
      ref: {
        instances: [{ id: 'u1', type: 'user:rp', inputs: { length: 5 } }],
        instanceId: 'u1',
        outputId: 'v',
        title: 'Srp 5',
      },
    };
    const r = formToAlert(form(left), { registry });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.code)).toContain('unsupported_indicator');
  });
});
