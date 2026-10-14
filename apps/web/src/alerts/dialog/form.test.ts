import type { Alert, AlertIn } from '@investopen/alerts';
import { DEFAULT_NOTIFY } from '@investopen/alerts';
import { describe, expect, it } from 'vitest';
import { alertToForm, cloneForm, emptyValue, formToAlert, type FormState } from './form';

const rsi = {
  kind: 'indicator' as const,
  ref: {
    instances: [{ id: 'r', type: 'rsi', inputs: { length: 14, source: 'close' } }],
    instanceId: 'r',
    outputId: 'rsi',
    title: 'RSI 14 close',
  },
};

const mk = (spec: AlertIn['spec'], o: Partial<AlertIn> = {}): AlertIn => ({
  id: 'a1',
  name: 'Test',
  symbol: 'AAPL',
  interval: '1D',
  prepost: false,
  spec,
  message: '{{ticker}}',
  notify: { ...DEFAULT_NOTIFY },
  expiresAt: '2027-01-01T10:00:00.000Z',
  status: 'active',
  ...o,
});

const close = { kind: 'price' as const, field: 'close' as const };
const specs: [string, AlertIn['spec']][] = [
  [
    'value',
    {
      schemaVersion: 1,
      left: close,
      condition: { op: 'crossingUp', right: { kind: 'value', value: 190.5 } },
      trigger: 'once',
    },
  ],
  [
    'indicator vs indicator',
    {
      schemaVersion: 1,
      left: rsi,
      condition: { op: 'less', right: { kind: 'price', field: 'low' } },
      trigger: 'everyTime',
    },
  ],
  [
    'drawing line',
    {
      schemaVersion: 1,
      left: close,
      condition: {
        op: 'crossing',
        right: { kind: 'drawing', drawingId: 'd1', part: 'line', scale: 'log' },
      },
      trigger: 'oncePerBar',
    },
  ],
  [
    'channel bounds',
    {
      schemaVersion: 1,
      left: rsi,
      condition: {
        op: 'exitingChannel',
        channel: {
          kind: 'bounds',
          upper: { kind: 'value', value: 70 },
          lower: { kind: 'value', value: 30 },
        },
      },
      trigger: 'oncePerBarClose',
    },
  ],
  [
    'channel drawing',
    {
      schemaVersion: 1,
      left: close,
      condition: {
        op: 'enteringChannel',
        channel: { kind: 'drawing', drawingId: 'd2', scale: 'linear' },
      },
      trigger: 'once',
    },
  ],
  [
    'moving',
    {
      schemaVersion: 1,
      left: close,
      condition: { op: 'movingUpPercent', amount: 2.5, bars: 10 },
      trigger: 'once',
    },
  ],
];

const drawing = (id: string) =>
  id === 'd1'
    ? { type: 'trend-line', points: [1, 2], scope: 'symbol' as const, symbol: 'AAPL' }
    : { type: 'parallel-channel', points: [1, 2, 3], scope: 'all' as const, symbol: '' };

describe('form <-> spec round trip', () => {
  it.each(specs)('%s', (_n, spec) => {
    const a = mk(spec);
    const r = formToAlert(alertToForm(a), { drawing });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.alert).toMatchObject(a);
  });

  it('keeps notify, message and expiry', () => {
    const a = mk(specs[0]![1], {
      notify: {
        ...DEFAULT_NOTIFY,
        webhook: true,
        webhookUrl: 'https://x.test/h',
        webhookRaw: true,
      },
      expiresAt: null,
    });
    const r = formToAlert(alertToForm(a));
    expect(r.ok && r.alert.notify).toEqual(a.notify);
    expect(r.ok && r.alert.expiresAt).toBeNull();
  });
});

describe('formToAlert', () => {
  const base = alertToForm(mk(specs[0]![1]));

  it('names an unnamed alert from the condition', () => {
    const r = formToAlert({ ...base, name: '  ' });
    expect(r.ok && r.alert.name).toBe('AAPL Crossing Up 190.50');
  });

  it('reports unparsable numbers by path', () => {
    const r = formToAlert({ ...base, right: { kind: 'value', text: 'abc' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0]?.path).toBe('spec.condition.right.value');
    const e = formToAlert({ ...base, right: emptyValue() });
    expect(e.ok).toBe(false);
  });

  it('validates moving amounts and whole bars', () => {
    const f: FormState = { ...base, op: 'movingUp', amount: '0', bars: '1.5' };
    const r = formToAlert(f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain('spec.condition.bars');
  });

  it('rejects a drawing that is not saved when drawings are checked', () => {
    const f = alertToForm(mk(specs[2]![1]));
    const r = formToAlert(f, { drawing: () => null });
    expect(r.ok).toBe(false);
  });

  it('sends an empty webhook URL as null', () => {
    const r = formToAlert({ ...base, notify: { ...base.notify, webhookUrl: '  ' } });
    expect(r.ok && r.alert.notify.webhookUrl).toBeNull();
  });
});

describe('cloneForm', () => {
  const stored: Alert = {
    ...mk(specs[0]![1], { name: 'Breakout' }),
    id: 'a1',
    status: 'triggered',
    statusReason: null,
    drawingId: null,
    revision: 4,
    fireCount: 2,
    lastFiredAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as Alert;

  it('is a new paused copy named "<name> (copy)"', () => {
    const f = cloneForm(stored);
    expect(f.id).toBeUndefined();
    expect(f.name).toBe('Breakout (copy)');
    expect(f.status).toBe('paused');
    const r = formToAlert(f);
    expect(r.ok && r.alert.id).toBeUndefined();
    expect(r.ok && r.alert.status).toBe('paused');
  });

  it('keeps the name within the limit', () => {
    const f = cloneForm({ ...stored, name: 'x'.repeat(200) });
    expect(Array.from(f.name)).toHaveLength(200);
    expect(f.name.endsWith(' (copy)')).toBe(true);
  });
});
