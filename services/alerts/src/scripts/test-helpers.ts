/** Shared by the script tests: fixtures, a deterministic bar generator, a host over a fake clock. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  compileUserScript,
  probeLineOffset,
  toManifest,
  type UserScriptManifest,
} from '@tickerglass/indicators';
import { FakeClock } from '../test-utils';
import { silentLogger } from '../log';
import { ScriptHost, type ScriptHostOptions } from './host';
import type { Columns } from './protocol';

const GOLDEN = new URL('../../../../packages/indicators/test/user-scripts/', import.meta.url);

/** Source of a golden script (`sma`, `rsi`, `macd`, `bollinger`, `zigzag`). */
export function golden(name: string): string {
  return readFileSync(fileURLToPath(new URL(`${name}.js`, GOLDEN)), 'utf8');
}

/** The manifest the web would have stored for `source` (compiled in this process). */
export function manifestOf(id: string, source: string): UserScriptManifest {
  const { definition } = compileUserScript(source, { scriptId: id, lineOffset: probeLineOffset() });
  return toManifest(definition);
}

export function bars(n: number, seed = 1, start = 1_700_000_000, step = 60): Columns {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const c: Columns = {
    time: new Float64Array(n),
    open: new Float64Array(n),
    high: new Float64Array(n),
    low: new Float64Array(n),
    close: new Float64Array(n),
    volume: new Float64Array(n),
  };
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = open + (rnd() - 0.5) * 2;
    c.time[i] = start + i * step;
    c.open[i] = open;
    c.close[i] = close;
    c.high[i] = Math.max(open, close) + rnd();
    c.low[i] = Math.min(open, close) - rnd();
    c.volume[i] = 1000 + Math.floor(rnd() * 500);
    price = close;
  }
  return c;
}

export function slice(c: Columns, from: number, to: number): Columns {
  return {
    time: c.time.slice(from, to),
    open: c.open.slice(from, to),
    high: c.high.slice(from, to),
    low: c.low.slice(from, to),
    close: c.close.slice(from, to),
    volume: c.volume.slice(from, to),
  };
}

export function barAt(c: Columns, i: number) {
  return {
    time: c.time[i]!,
    open: c.open[i]!,
    high: c.high[i]!,
    low: c.low[i]!,
    close: c.close[i]!,
    volume: c.volume[i]!,
  };
}

export const CTX = { timezone: 'UTC', session: null, intervalSeconds: 60 } as const;

export async function makeHost(
  over: Partial<
    Pick<ScriptHostOptions, 'memoryMb' | 'loadMs' | 'tickMs' | 'cpuPct' | 'cpuTotalPct'>
  > = {},
  clock = new FakeClock(1_800_000_000_000),
): Promise<{ host: ScriptHost; clock: FakeClock }> {
  const host = await ScriptHost.create({
    memoryMb: 128,
    loadMs: 10_000,
    tickMs: 250,
    clock,
    log: silentLogger,
    ...over,
  });
  return { host, clock };
}
