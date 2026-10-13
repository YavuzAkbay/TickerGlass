import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUILTIN_INDICATORS } from '../src/builtins';
import type { AnyIndicatorDefinition } from '../src/registry';
import { resolveInputs, timeframeInputValue } from '../src/resolve';
import { IndicatorRuntime } from '../src/runtime';
import type { BarArrays, IndicatorResult, InputValueMap } from '../src/types';
import { dailyBars, feedLive, snapshot, toColumns } from './helpers';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'golden');

interface Csv {
  inputs: InputValueMap;
  ref: string;
  cols: Record<string, Float64Array>;
}

function parseCsv(file: string): Csv {
  const lines = readFileSync(join(DIR, file), 'utf8').trimEnd().split('\n');
  let inputs: InputValueMap = {};
  let ref = '';
  if (lines[0]!.startsWith('#')) {
    const m = /^# inputs: (\{.*\}) ref: (\w+)$/.exec(lines.shift()!);
    if (!m) throw new Error(`${file}: bad header`);
    inputs = JSON.parse(m[1]!) as InputValueMap;
    ref = m[2]!;
  }
  const names = lines.shift()!.split(',');
  const cols: Record<string, Float64Array> = {};
  for (const name of names) cols[name] = new Float64Array(lines.length);
  lines.forEach((line, i) => {
    line.split(',').forEach((cell, k) => {
      cols[names[k]!]![i] = cell === '' ? NaN : Number(cell);
    });
  });
  return { inputs, ref, cols };
}

const bars = parseCsv('bars.csv').cols as unknown as BarArrays;
const cases = readdirSync(DIR)
  .filter((f) => f.endsWith('.csv') && f !== 'bars.csv')
  .map((f) => f.slice(0, -4))
  .sort();

/** Longest registered id that is the case name or a `<id>-` prefix of it. */
function definitionFor(name: string): AnyIndicatorDefinition {
  const def = [...BUILTIN_INDICATORS]
    .filter((d) => name === d.id || name.startsWith(`${d.id}-`))
    .sort((a, b) => b.id.length - a.id.length)[0];
  if (!def) throw new Error(`No indicator for golden case "${name}"`);
  return def;
}

function run(def: AnyIndicatorDefinition, inputs: InputValueMap, live: boolean): IndicatorResult {
  const tf = timeframeInputValue(def, resolveInputs(def, inputs));
  if (tf && tf !== '1D') throw new Error(`golden tests only aggregate 1D bars, got ${tf}`);
  const rt = new IndicatorRuntime();
  rt.add({ id: 'x', type: def.id, inputs });
  if (live) feedLive(rt, bars, 500, tf);
  else {
    rt.setBars(bars);
    if (tf) rt.setTimeframeBars(tf, toColumns(dailyBars(bars)));
  }
  const r = rt.result('x')!;
  expect(r.status).toEqual({ state: 'ok' });
  expect(r.length).toBe(bars.time.length);
  return r;
}

function close(a: number, b: number): boolean {
  if (Number.isNaN(b)) return Number.isNaN(a);
  return Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(b));
}

describe('golden reference values', () => {
  it('has a golden case for every built-in', () => {
    const covered = new Set(cases.map((c) => definitionFor(c).id));
    expect(BUILTIN_INDICATORS.map((d) => d.id).filter((id) => !covered.has(id))).toEqual([]);
  });

  it.each(cases)('%s', (name) => {
    const def = definitionFor(name);
    const { inputs, cols } = parseCsv(`${name}.csv`);
    const full = run(def, inputs, false);

    // Every value output and every palette is covered by the reference.
    const valueIds = def.outputs
      .filter((o) => o.type === 'plot' || o.type === 'shape' || o.type === 'bgcolor')
      .map((o) => o.id);
    const refCols = Object.keys(cols).filter((k) => k !== 'time');
    expect(refCols.filter((k) => !k.endsWith('.color')).sort()).toEqual(valueIds.sort());
    for (const id of Object.keys(full.colors)) expect(refCols).toContain(`${id}.color`);

    for (const col of refCols) {
      const ref = cols[col]!;
      const colorOf = col.endsWith('.color') ? col.slice(0, -'.color'.length) : null;
      const got = colorOf ? full.colors[colorOf]! : full.values[col]!;
      const bad: string[] = [];
      for (let i = 0; i < ref.length; i++) {
        const ok = colorOf ? got[i] === ref[i] : close(got[i]!, ref[i]!);
        if (!ok && bad.length < 5) bad.push(`[${i}] got ${got[i]} want ${ref[i]}`);
      }
      expect(bad, `${name}.${col}`).toEqual([]);
    }

    // Live ticks and appends from bar 500 give identical arrays.
    expect(snapshot(run(def, inputs, true))).toEqual(snapshot(full));
  });
});
