/**
 * Typed commands for the command palette: "rsi 14", "4h", "compare MSFT",
 * "alert above 200", "line chart". Pure parsing; the palette turns each intent
 * into a row and runs it. A query can mean several things ("line" is a chart type
 * and the start of indicator names), so every match is listed, best first.
 */
import type { ChartType } from '@tickerglass/engine';
import { parseTypedInterval } from '../topbar/intervals';

/** The part of an indicator definition the parser needs. */
export interface IndicatorInfo {
  id: string;
  name: string;
  shortName: string;
  /** Numeric inputs in definition order: typed numbers fill them left to right. */
  numeric: { key: string; label: string; kind: 'int' | 'float'; min?: number; max?: number }[];
}

export interface ChartTypeInfo {
  id: ChartType;
  label: string;
}

export type AlertOp = 'crossing' | 'crossingUp' | 'crossingDown' | 'greater' | 'less';

export type Intent =
  | { kind: 'interval'; interval: string }
  | { kind: 'indicator'; type: string; name: string; inputs: Record<string, number> }
  | { kind: 'compare'; symbol: string }
  | { kind: 'alert'; price: number; op: AlertOp }
  | { kind: 'chartType'; chartType: ChartType; label: string };

const NUMBER = /^-?\d+(?:\.\d+)?$/;
const SYMBOL = /^[A-Za-z0-9^][A-Za-z0-9.=^:/-]{0,31}$/;

const ALERT_OPS: Record<string, AlertOp> = {
  above: 'crossingUp',
  over: 'crossingUp',
  '>': 'crossingUp',
  below: 'crossingDown',
  under: 'crossingDown',
  '<': 'crossingDown',
  at: 'crossing',
  crosses: 'crossing',
  crossing: 'crossing',
  '>=': 'greater',
  '<=': 'less',
};

/** Interval words people type: "4h", "15 min", "1 day", "weekly". */
function interval(q: string): string | null {
  const named: Record<string, string> = {
    daily: '1D',
    weekly: '1W',
    monthly: '1M',
    hourly: '1h',
  };
  if (named[q.toLowerCase()]) return named[q.toLowerCase()]!;
  const m = /^(\d+)\s*([a-zA-Z]+)$/.exec(q);
  if (!m) return null;
  // "M" alone is months; every other unit is case-insensitive ("1D", "15MIN").
  const unit = m[2] === 'M' ? 'mo' : m[2]!.toLowerCase();
  const units: [RegExp, string][] = [
    [/^(m|min|mins|minutes?)$/, 'm'],
    [/^(h|hr|hrs|hours?)$/, 'h'],
    [/^(d|days?)$/, 'D'],
    [/^(w|wk|weeks?)$/, 'W'],
    [/^(mo|months?)$/, 'M'],
  ];
  const letter = units.find(([re]) => re.test(unit))?.[1];
  if (!letter) return null;
  return parseTypedInterval(`${m[1]}${letter}`);
}

function indicators(words: string[], list: readonly IndicatorInfo[]): Intent[] {
  // Leading words are the name, trailing numbers the inputs: "bollinger bands 20 2".
  let split = words.length;
  while (split > 0 && NUMBER.test(words[split - 1]!)) split--;
  if (split === 0) return [];
  const name = words.slice(0, split).join(' ').toLowerCase();
  const numbers = words.slice(split).map(Number);
  const scored: { info: IndicatorInfo; score: number }[] = [];
  for (const info of list) {
    const short = info.shortName.toLowerCase();
    const full = info.name.toLowerCase();
    let score = 0;
    if (short === name || info.id === name) score = 4;
    else if (full === name) score = 3;
    else if (name.length >= 2 && (full.startsWith(name) || short.startsWith(name))) score = 2;
    else if (name.length >= 3 && full.split(/[^a-z0-9]+/).some((w) => w.startsWith(name)))
      score = 1;
    if (score > 0 && numbers.length <= info.numeric.length) scored.push({ info, score });
  }
  scored.sort((a, b) => b.score - a.score || a.info.name.localeCompare(b.info.name));
  return scored.slice(0, 3).flatMap(({ info }) => {
    const inputs: Record<string, number> = {};
    for (let i = 0; i < numbers.length; i++) {
      const def = info.numeric[i]!;
      let v = numbers[i]!;
      if (def.kind === 'int' && !Number.isInteger(v)) return [];
      if (def.min !== undefined) v = Math.max(def.min, v);
      if (def.max !== undefined) v = Math.min(def.max, v);
      inputs[def.key] = v;
    }
    return [{ kind: 'indicator', type: info.id, name: info.shortName, inputs } as Intent];
  });
}

function chartTypes(q: string, list: readonly ChartTypeInfo[]): Intent[] {
  const name = q
    .toLowerCase()
    .replace(/^(chart|type|style)\s+/, '')
    .replace(/\s+(chart|style)$/, '');
  if (!name) return [];
  const hit = list.find((t) => t.label.toLowerCase() === name || t.id.toLowerCase() === name);
  return hit ? [{ kind: 'chartType', chartType: hit.id, label: hit.label }] : [];
}

/** Every intent `query` can mean, most likely first. */
export function parseIntents(
  query: string,
  ctx: { indicators: readonly IndicatorInfo[]; chartTypes: readonly ChartTypeInfo[] },
): Intent[] {
  const q = query.trim().replace(/\s+/g, ' ');
  if (!q) return [];
  const words = q.split(' ');
  const head = words[0]!.toLowerCase();
  const out: Intent[] = [];

  if ((head === 'compare' || head === 'vs' || head === 'cmp') && words.length === 2) {
    if (SYMBOL.test(words[1]!)) out.push({ kind: 'compare', symbol: words[1]!.toUpperCase() });
    return out;
  }

  if (head === 'alert') {
    const rest = words.slice(1);
    const op = rest.length === 2 ? ALERT_OPS[rest[0]!.toLowerCase()] : 'crossing';
    const price = rest.at(-1);
    if (op && price && NUMBER.test(price) && rest.length <= 2)
      out.push({ kind: 'alert', price: Number(price), op });
    return out;
  }

  const iv = interval(q);
  if (iv) out.push({ kind: 'interval', interval: iv });
  out.push(...chartTypes(q, ctx.chartTypes));
  out.push(...indicators(words, ctx.indicators));
  return out;
}

/** Examples shown while the palette is empty. */
export const INTENT_EXAMPLES = ['rsi 14', '4h', 'compare MSFT', 'alert above 200', 'line chart'];
