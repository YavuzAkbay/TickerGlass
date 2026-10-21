/**
 * Golden reuse for user scripts: `test/user-scripts/*.js` re-implement
 * built-ins with only the public script contract (injected `defineIndicator`,
 * `NO_COLOR`, `PRICE_SOURCES`, `calendarPeriod`; `ta` and the step context)
 * and must reproduce the built-ins' golden references, live and repaint
 * behaviour.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_INDICATORS } from '../src/builtins';
import { IndicatorRegistry, type AnyIndicatorDefinition } from '../src/registry';
import { IndicatorRuntime, type Change } from '../src/runtime';
import { randomBars } from '../src/test-utils';
import type { BarInput, InputValueMap } from '../src/types';
import {
  USER_SCRIPT_PREFIX,
  compileUserScript,
  parseManifest,
  probeLineOffset,
} from '../src/user-script';
import { GOLDEN_CASES, expectGolden, isCaseOf } from './golden-harness';
import { feedLive, feedTicks, snapshot, swingTicks, toColumns } from './helpers';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'user-scripts');
const LINE_OFFSET = probeLineOffset();

/** Script file name = id of the built-in it re-implements. */
const SCRIPTS = ['sma', 'rsi', 'macd', 'bollinger', 'zigzag'] as const;
type Script = (typeof SCRIPTS)[number];

function compile(name: Script) {
  const source = readFileSync(join(DIR, `${name}.js`), 'utf8');
  return compileUserScript(source, { scriptId: name, lineOffset: LINE_OFFSET });
}

/** Built-ins plus every script (as `user:<name>`). */
const registry = new IndicatorRegistry();
for (const def of BUILTIN_INDICATORS) registry.register(def);
const USER: Record<Script, AnyIndicatorDefinition> = Object.fromEntries(
  SCRIPTS.map((name) => {
    const { definition } = compile(name);
    registry.register(definition);
    return [name, definition];
  }),
) as Record<Script, AnyIndicatorDefinition>;
const typeOf = (name: Script) => USER_SCRIPT_PREFIX + name;

describe('user script fixtures', () => {
  it.each(SCRIPTS)('%s compiles to a valid manifest with a forced id', (name) => {
    const { definition, manifest } = compile(name);
    expect(definition.id).toBe(typeOf(name));
    expect(parseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });
});

describe('user scripts match the golden references', () => {
  const cases = SCRIPTS.flatMap((script) =>
    GOLDEN_CASES.filter((name) => isCaseOf(name, script)).map((name) => ({ script, name })),
  );

  it('covers every script', () => {
    expect(new Set(cases.map((c) => c.script))).toEqual(new Set(SCRIPTS));
  });

  it.each(cases)('$name (script $script)', ({ script, name }) => {
    // The MACD script hides warm-up bars with NO_COLOR; the reference gives
    // them the index of its formula (never drawn: the value is NaN).
    expectGolden(name, USER[script], registry, { noColorOnNaN: script === 'macd' });
  });
});

describe('user scripts: live ticks and appends equal a full computation', () => {
  const bars = randomBars(400, 7, 1_700_000_000, 900);
  const cases: { script: Script; inputs: InputValueMap }[] = [
    { script: 'sma', inputs: { length: 20, source: 'hlc3' } },
    { script: 'rsi', inputs: {} },
    { script: 'rsi', inputs: { maType: 'Bollinger Bands', maLength: 20 } },
    { script: 'rsi', inputs: { maType: 'VWMA' } },
    { script: 'macd', inputs: {} },
    { script: 'macd', inputs: { oscMa: 'SMA', signalMa: 'SMA' } },
    { script: 'bollinger', inputs: {} },
    { script: 'bollinger', inputs: { maType: 'VWMA', length: 10 } },
    { script: 'zigzag', inputs: {} },
    { script: 'zigzag', inputs: { deviation: 1, depth: 4, showPrice: false } },
  ];

  it.each(cases)('$script $inputs', ({ script, inputs }) => {
    const full = new IndicatorRuntime({ registry });
    full.add({ id: 'x', type: typeOf(script), inputs });
    full.setBars(bars);
    const live = new IndicatorRuntime({ registry });
    live.add({ id: 'x', type: typeOf(script), inputs });
    feedLive(live, bars, 300);
    const r = full.result('x')!;
    expect(r.status).toEqual({ state: 'ok' });
    expect(Object.values(r.values).some((v) => v.subarray(0, r.length).some(Number.isFinite))).toBe(
      true,
    );
    expect(snapshot(live.result('x')!)).toEqual(snapshot(r));
  });
});

describe('user ZigZag repaints like the built-in', () => {
  /** ZigZag `z` of `type` with an SMA of its line as dependent `ma`. */
  function withSma(type: string, inputs: InputValueMap): IndicatorRuntime {
    const rt = new IndicatorRuntime({ registry });
    rt.add({ id: 'z', type, inputs });
    rt.add({
      id: 'ma',
      type: 'sma',
      inputs: { length: 2, source: { instanceId: 'z', outputId: 'zz' } },
    });
    return rt;
  }

  it.each([
    { deviation: 1, depth: 4 },
    { deviation: 3, depth: 10 },
    { deviation: 0.5, depth: 5, extendToLastBar: false },
    { deviation: 2, depth: 6, showPrice: false },
  ])('same changes and arrays over wild ticks (%o)', (inputs) => {
    const bars = randomBars(400, 5, 1_700_000_000, 900);
    const builtin = withSma('zigzag', inputs);
    const user = withSma(typeOf('zigzag'), inputs);
    const want = feedTicks(builtin, bars, 60, swingTicks);
    const got = feedTicks(user, bars, 60, swingTicks);
    expect(got).toEqual(want);
    // Some ticks repainted the past (pivots appear d >= 2 bars back).
    expect(got.some((cs) => cs.some((c) => c.id === 'z' && c.from < user.length - 2))).toBe(true);
    expect(snapshot(user.result('z')!)).toEqual(snapshot(builtin.result('z')!));
    expect(snapshot(user.result('ma')!)).toEqual(snapshot(builtin.result('ma')!));

    const full = withSma(typeOf('zigzag'), inputs);
    full.setBars(bars);
    expect(snapshot(user.result('z')!)).toEqual(snapshot(full.result('z')!));
  });

  it('creates, cancels and moves pivots with the same Change.from', () => {
    // Flat bars (open = high = low = close), one minute apart.
    const at = (i: number, p: number): BarInput => ({
      time: i * 60,
      open: p,
      high: p,
      low: p,
      close: p,
      volume: 1,
    });
    const history = [100, 101, 102, 110, 107].map((p, i) => at(i, p));
    // [bar, price] ticks: confirm, cancel, restore, append, move, undo, reverse.
    const ticks: [number, number][] = [
      [5, 106],
      [5, 111],
      [5, 106],
      [6, 108],
      [7, 109],
      [8, 115],
      [9, 112],
      [10, 111],
      [10, 116],
      [10, 117],
      [10, 111],
      [11, 104],
      [12, 100],
      [13, 101],
      [14, 103],
    ];
    const inputs = { deviation: 5, depth: 4 };
    const run = (type: string) => {
      const rt = withSma(type, inputs);
      rt.setBars(toColumns(history));
      const changes: Change[][] = ticks.map(([i, p]) => rt.updateBar(i, at(i, p)));
      return { rt, changes };
    };
    const builtin = run('zigzag');
    const user = run(typeOf('zigzag'));
    expect(user.changes).toEqual(builtin.changes);
    // The first tick confirms the high at bar 3; the move at bar 10 starts at 3 too.
    expect(user.changes[0]!.find((c) => c.id === 'z')?.from).toBe(3);
    expect(user.changes[7]!.find((c) => c.id === 'z')?.from).toBe(3);
    const zz = user.rt.result('z')!.values.zz!;
    expect(zz[8]).toBe(115);
    expect(zz[12]).toBe(100);
    expect(snapshot(user.rt.result('z')!)).toEqual(snapshot(builtin.rt.result('z')!));
  });
});
