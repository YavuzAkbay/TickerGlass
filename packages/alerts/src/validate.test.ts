import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IndicatorRegistry, SMA } from '@tickerglass/indicators';
import { describe, expect, it } from 'vitest';
import { validateAlert, type DrawingInfo, type ValidationCode } from './validate';

const FIXTURES = join(import.meta.dirname, '../test/fixtures');

/** JSON with Python's `Infinity`/`NaN` literals (the shared fixtures use them). */
function parse(text: string): unknown {
  const marked = text.replace(/:\s*(-?Infinity|NaN)\b/g, ': {"$num": "$1"}');
  return JSON.parse(marked, (_k, v: unknown) =>
    typeof v === 'object' && v !== null && '$num' in v ? Number((v as { $num: string }).$num) : v,
  );
}

const load = (dir: string) =>
  readdirSync(join(FIXTURES, dir))
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(
      (f) =>
        [f.replace(/\.json$/, ''), parse(readFileSync(join(FIXTURES, dir, f), 'utf8'))] as const,
    );

/** The named error of every invalid fixture: [path, code]. */
const EXPECTED: Record<string, [string, ValidationCode]> = {
  'amount-negative': ['spec.condition.amount', 'range'],
  'amount-zero': ['spec.condition.amount', 'range'],
  'bad-drawing-part': ['spec.condition.right.part', 'enum'],
  'bad-drawing-scale': ['spec.condition.right.scale', 'enum'],
  'bad-price-field': ['spec.left.field', 'enum'],
  'bad-schema-version': ['spec.schemaVersion', 'enum'],
  'bad-trigger': ['spec.trigger', 'enum'],
  'bars-fraction': ['spec.condition.bars', 'range'],
  'bars-too-many': ['spec.condition.bars', 'range'],
  'bars-zero': ['spec.condition.bars', 'range'],
  'extra-field': ['bogus', 'extra'],
  'id-bad-chars': ['id', 'format'],
  'id-reserved': ['id', 'reserved'],
  'id-too-long': ['id', 'format'],
  'infinite-value': ['spec.condition.right.value', 'type'],
  'instance-bad-id-chars': ['spec.left.ref.instances.0.id', 'format'],
  'instance-duplicate-id': ['spec.left.ref.instances.1.id', 'unique'],
  'instance-id-missing': ['spec.left.ref.instanceId', 'reference'],
  'instance-source-dangling': ['spec.left.ref.instances.0.inputs.source', 'reference'],
  'instances-17': ['spec.left.ref.instances', 'length'],
  'instances-empty': ['spec.left.ref.instances', 'length'],
  'interval-bad': ['interval', 'format'],
  'interval-zero': ['interval', 'format'],
  'left-is-drawing': ['spec.left.kind', 'enum'],
  'left-is-value': ['spec.left.kind', 'enum'],
  'message-too-long': ['message', 'length'],
  'name-empty': ['name', 'length'],
  'name-too-long': ['name', 'length'],
  'percent-too-big': ['spec.condition.amount', 'range'],
  'status-triggered': ['status', 'enum'],
  'string-value': ['spec.condition.right.value', 'type'],
  'symbol-control-char': ['symbol', 'format'],
  'symbol-empty': ['symbol', 'length'],
  'symbol-too-long': ['symbol', 'length'],
  'unknown-op': ['spec.condition.op', 'enum'],
  'webhook-url-not-http': ['notify.webhookUrl', 'format'],
  'webhook-url-too-long': ['notify.webhookUrl', 'length'],
  // TS-only (registry) checks.
  cycle: ['spec.left.ref.instances', 'cycle'],
  'invalid-inputs': ['spec.left.ref.instances.0.inputs', 'invalid_inputs'],
  'output-not-plot': ['spec.left.ref.outputId', 'unknown_output'],
  'output-unknown': ['spec.left.ref.outputId', 'unknown_output'],
  'source-output-not-plot': ['spec.left.ref.instances.1.inputs.source', 'unknown_output'],
  'unknown-indicator': ['spec.left.ref.instances.0.type', 'unknown_indicator'],
};

describe('shared fixtures', () => {
  it.each(load('valid'))('valid/%s passes', (_name, body) => {
    const r = validateAlert(body);
    expect(r.ok ? [] : r.errors).toEqual([]);
  });

  it.each([...load('invalid'), ...load('invalid-ts')])(
    'invalid/%s fails with its named error',
    (name, body) => {
      const want = EXPECTED[name];
      expect(want, `add ${name} to EXPECTED`).toBeDefined();
      const r = validateAlert(body);
      expect(r.ok).toBe(false);
      if (r.ok || !want) return;
      expect(r.errors.map((e) => [e.path, e.code])).toContainEqual(want);
    },
  );
});

const base = () =>
  parse(readFileSync(join(FIXTURES, 'valid/price-crossing-value.json'), 'utf8')) as Record<
    string,
    unknown
  >;

describe('validateAlert', () => {
  it('fills the API defaults and trims the name', () => {
    const { prepost: _p, message: _m, notify: _n, expiresAt: _e, ...minimal } = base();
    const r = validateAlert({ ...minimal, name: '  AAPL  ', id: null, status: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.alert).toMatchObject({ name: 'AAPL', prepost: false, message: '', expiresAt: null });
    expect(r.alert.notify).toEqual({
      toast: true,
      sound: true,
      browser: false,
      webhook: false,
      webhookUrl: null,
      webhookRaw: false,
      telegram: false,
      email: false,
    });
    expect('id' in r.alert).toBe(false);
  });

  it('rejects a non-object body and unknown nested keys', () => {
    expect(validateAlert(null).ok).toBe(false);
    const b = base();
    const spec = b['spec'] as Record<string, unknown>;
    const r = validateAlert({
      ...b,
      spec: { ...spec, left: { kind: 'price', field: 'close', x: 1 } },
    });
    expect(r.ok ? [] : r.errors.map((e) => [e.path, e.code])).toEqual([['spec.left.x', 'extra']]);
  });

  it('accepts unicode printable symbols and ISO dates with offsets', () => {
    expect(validateAlert({ ...base(), symbol: 'Ä/B C' }).ok).toBe(true);
    expect(validateAlert({ ...base(), symbol: 'A​B' }).ok).toBe(false);
    expect(validateAlert({ ...base(), expiresAt: '2099-01-01T00:00:00+02:00' }).ok).toBe(true);
    expect(validateAlert({ ...base(), expiresAt: 'tomorrow' }).ok).toBe(false);
  });

  it('limits indicator instances per spec across operands', () => {
    const ref = (n: number) => ({
      kind: 'indicator',
      ref: {
        instances: Array.from({ length: n }, (_, i) => ({ id: `i${i}`, type: 'sma', inputs: {} })),
        instanceId: 'i0',
        outputId: 'ma',
        title: 'SMA',
      },
    });
    const spec = (a: number, b: number) => ({
      schemaVersion: 1,
      left: ref(a),
      condition: { op: 'crossing', right: ref(b) },
      trigger: 'once',
    });
    expect(validateAlert({ ...base(), spec: spec(8, 8) }).ok).toBe(true);
    const r = validateAlert({ ...base(), spec: spec(9, 8) });
    expect(r.ok ? [] : r.errors.map((e) => [e.path, e.code])).toEqual([['spec', 'too_large']]);
  });

  it('checks drawings when a lookup is given', () => {
    const drawings: Record<string, DrawingInfo> = {
      line: { type: 'trend-line', points: [{}, {}], scope: 'symbol', symbol: 'AAPL' },
      other: { type: 'trend-line', points: [{}, {}], scope: 'symbol', symbol: 'MSFT' },
      shared: { type: 'horizontal-line', points: [{}], scope: 'all', symbol: 'MSFT' },
      chan: { type: 'parallel-channel', points: [{}, {}, {}], scope: 'all', symbol: 'X' },
      chan2: { type: 'parallel-channel', points: [{}, {}], scope: 'all', symbol: 'X' },
      rect: { type: 'rectangle', points: [{}, {}], scope: 'all', symbol: 'X' },
      flat: { type: 'flat-channel', points: [{}, {}, {}], scope: 'all', symbol: 'X' },
      disjoint: { type: 'split-channel', points: [{}, {}, {}, {}], scope: 'all', symbol: 'X' },
      disjoint2: { type: 'split-channel', points: [{}, {}], scope: 'all', symbol: 'X' },
      fib: { type: 'fib-retracement', points: [{}, {}], scope: 'all', symbol: 'X' },
    };
    const opts = { drawing: (id: string) => drawings[id] };
    const withRight = (drawingId: string, part: string) => {
      const b = base();
      const spec = b['spec'] as Record<string, unknown>;
      return {
        ...b,
        spec: {
          ...spec,
          condition: {
            op: 'crossing',
            right: { kind: 'drawing', drawingId, part, scale: 'linear' },
          },
        },
      };
    };
    const codes = (body: unknown) => {
      const r = validateAlert(body, undefined, opts);
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codes(withRight('line', 'line'))).toEqual([]);
    expect(codes(withRight('shared', 'line'))).toEqual([]);
    expect(codes(withRight('chan', 'upper'))).toEqual([]);
    expect(codes(withRight('rect', 'middle'))).toEqual([]);
    expect(codes(withRight('missing', 'line'))).toEqual(['drawing_not_saved']);
    expect(codes(withRight('other', 'line'))).toEqual(['drawing_symbol']);
    expect(codes(withRight('line', 'upper'))).toEqual(['drawing_unsupported']);
    expect(codes(withRight('chan', 'line'))).toEqual(['drawing_unsupported']);
    expect(codes(withRight('chan2', 'upper'))).toEqual(['drawing_unsupported']);
    expect(codes(withRight('fib', 'line'))).toEqual(['drawing_unsupported']);
    const channel = (drawingId: string) => {
      const b = base();
      const spec = b['spec'] as Record<string, unknown>;
      return {
        ...b,
        spec: {
          ...spec,
          condition: { op: 'insideChannel', channel: { kind: 'drawing', drawingId, scale: 'log' } },
        },
      };
    };
    expect(codes(channel('chan'))).toEqual([]);
    expect(codes(channel('rect'))).toEqual([]);
    expect(codes(channel('line'))).toEqual(['drawing_unsupported']);
    expect(codes(channel('chan2'))).toEqual(['drawing_unsupported']);
    expect(codes(channel('flat'))).toEqual([]);
    expect(codes(channel('disjoint'))).toEqual([]);
    expect(codes(channel('disjoint2'))).toEqual(['drawing_unsupported']);
    // Without a lookup, drawings are not checked (shape only).
    expect(validateAlert(withRight('missing', 'line')).ok).toBe(true);
  });

  it('rejects an oversized spec', () => {
    const b = base();
    const spec = b['spec'] as Record<string, unknown>;
    const big = {
      ...spec,
      left: {
        kind: 'indicator',
        ref: {
          instances: [
            {
              id: 'a',
              type: 'sma',
              inputs: Object.fromEntries(
                Array.from({ length: 64 }, (_, i) => [`k${i}`, 'x'.repeat(200)]),
              ),
            },
          ],
          instanceId: 'a',
          outputId: 'ma',
          title: 'SMA'.repeat(60),
        },
      },
    };
    // 64 x 200-char strings is ~14 KB: still fine; four refs worth is not possible (16 instances).
    expect(validateAlert({ ...b, spec: big }).ok).toBe(true);
    const huge = {
      ...big,
      left: {
        ...big.left,
        ref: {
          ...big.left.ref,
          instances: Array.from({ length: 16 }, (_, i) => ({
            ...big.left.ref.instances[0]!,
            id: `i${i}`,
          })),
          instanceId: 'i0',
        },
      },
    };
    const r = validateAlert({ ...b, spec: huge });
    expect(r.ok ? [] : r.errors.map((e) => [e.path, e.code])).toContainEqual(['spec', 'too_large']);
  });
});

describe('indicators that alerts cannot evaluate', () => {
  const registry = new IndicatorRegistry();
  registry.register(SMA);
  const plotOnly = {
    category: 'other',
    overlay: true,
    outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#000' }],
    setup: () => () => {},
  } as const;
  registry.register({
    ...plotOnly,
    id: 'zz',
    name: 'ZigZag',
    shortName: 'ZZ',
    repaints: true,
    inputs: {},
  });
  registry.register({
    ...plotOnly,
    id: 'corr',
    name: 'Correlation',
    shortName: 'CC',
    inputs: { symbol: { kind: 'symbol', label: 'Symbol', default: 'GOOG' } },
  });

  const withLeft = (instances: unknown[], instanceId: string, outputId: string) => {
    const b = base();
    const spec = b['spec'] as Record<string, unknown>;
    return {
      ...b,
      spec: {
        ...spec,
        left: { kind: 'indicator', ref: { instances, instanceId, outputId, title: 'X' } },
      },
    };
  };
  const errors = (body: unknown) => {
    const r = validateAlert(body, registry);
    return r.ok ? [] : r.errors.map((e) => [e.path, e.code, e.message]);
  };

  it('rejects repainting definitions, also upstream of the operand', () => {
    expect(errors(withLeft([{ id: 'z', type: 'zz', inputs: {} }], 'z', 'v'))).toEqual([
      [
        'spec.left.ref.instances.0.type',
        'unsupported_indicator',
        'ZigZag repaints past values and cannot be used in alerts',
      ],
    ]);
    const chain = [
      { id: 'z', type: 'zz', inputs: {} },
      { id: 'm', type: 'sma', inputs: { source: { instanceId: 'z', outputId: 'v' } } },
    ];
    expect(errors(withLeft(chain, 'm', 'ma')).map((e) => e[1])).toEqual(['unsupported_indicator']);
  });

  it('rejects event-anchored VWAP, accepts calendar anchors', () => {
    const run = (anchor: string) => {
      const b = withLeft([{ id: 'v', type: 'vwap', inputs: { anchor } }], 'v', 'vwap');
      const r = validateAlert(b);
      return r.ok ? [] : r.errors.map((e) => [e.path, e.code]);
    };
    expect(run('Earnings')).toEqual([
      ['spec.left.ref.instances.0.inputs', 'unsupported_indicator'],
    ]);
    expect(run('Dividends')).toHaveLength(1);
    expect(run('Session')).toEqual([]);
  });

  it('rejects symbol inputs and sources on another symbol', () => {
    expect(errors(withLeft([{ id: 'c', type: 'corr', inputs: {} }], 'c', 'v'))).toEqual([
      [
        'spec.left.ref.instances.0.type',
        'unsupported_indicator',
        "Correlation uses another symbol's data and cannot be used in alerts",
      ],
    ]);
    const ext = [
      { id: 'm', type: 'sma', inputs: { source: { instanceId: 'sym:GOOG', outputId: 'close' } } },
    ];
    expect(errors(withLeft(ext, 'm', 'ma'))).toEqual([
      [
        'spec.left.ref.instances.0.inputs.source',
        'reference',
        "sources on another symbol ('sym:GOOG') are not supported in alerts",
      ],
    ]);
  });
});
