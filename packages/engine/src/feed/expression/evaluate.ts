import type { BarColumns } from '../../types';
import type { ExprNode } from './ast';

/** OHLC of one leg bar. */
export interface OhlcLike {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** Columnar leg bars; `time` is used for the primary (first) leg only. */
export type BarColumnsLike = Pick<BarColumns, 'time' | 'open' | 'high' | 'low' | 'close'>;

const finite = (v: number): number => (Number.isFinite(v) ? v : NaN);

function apply(op: '+' | '-' | '*' | '/', a: number, b: number): number {
  switch (op) {
    case '+':
      return finite(a + b);
    case '-':
      return finite(a - b);
    case '*':
      return finite(a * b);
    case '/':
      return b === 0 ? NaN : finite(a / b);
  }
}

/** Evaluate for one row. Division by zero and any non-finite intermediate give NaN. */
export function evalRow(ast: ExprNode, value: (symbol: string) => number): number {
  switch (ast.kind) {
    case 'num':
      return ast.value;
    case 'sym':
      return finite(value(ast.symbol));
    case 'neg':
      return -evalRow(ast.arg, value);
    case 'bin':
      return apply(ast.op, evalRow(ast.left, value), evalRow(ast.right, value));
  }
}

/** Evaluate over `n` rows of per-symbol columns. Throws if a symbol has no column. */
export function evalColumns(
  ast: ExprNode,
  legs: ReadonlyMap<string, Float64Array>,
  n: number,
): Float64Array {
  switch (ast.kind) {
    case 'num':
      return new Float64Array(n).fill(ast.value);
    case 'sym': {
      const col = legs.get(ast.symbol);
      if (col === undefined) throw new Error(`evalColumns: no column for ${ast.symbol}`);
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = finite(col[i] ?? NaN);
      return out;
    }
    case 'neg': {
      const out = evalColumns(ast.arg, legs, n);
      for (let i = 0; i < n; i++) out[i] = -(out[i] ?? NaN);
      return out;
    }
    case 'bin': {
      const l = evalColumns(ast.left, legs, n);
      const r = evalColumns(ast.right, legs, n);
      for (let i = 0; i < n; i++) l[i] = apply(ast.op, l[i] ?? NaN, r[i] ?? NaN);
      return l;
    }
  }
}

/**
 * Combine per-field values into a bar: O and C exact, H/L the envelope of O, C,
 * f(highs) and f(lows) (non-finite samples skipped). Null if O or C is not finite.
 */
function envelope(o: number, h: number, l: number, c: number): OhlcLike | null {
  if (!Number.isFinite(o) || !Number.isFinite(c)) return null;
  let hi = Math.max(o, c);
  let lo = Math.min(o, c);
  for (const v of [h, l]) {
    if (!Number.isFinite(v)) continue;
    if (v > hi) hi = v;
    if (v < lo) lo = v;
  }
  return { open: o, high: hi, low: lo, close: c };
}

/**
 * Expression bar from one bar per leg. A missing leg or non-finite O/C gives
 * null. Stale (forward-filled) legs must be passed as O=H=L=C=last close.
 */
export function evalBar(ast: ExprNode, legBars: ReadonlyMap<string, OhlcLike>): OhlcLike | null {
  const field = (k: keyof OhlcLike) => (s: string) => legBars.get(s)?.[k] ?? NaN;
  return envelope(
    evalRow(ast, field('open')),
    evalRow(ast, field('high')),
    evalRow(ast, field('low')),
    evalRow(ast, field('close')),
  );
}

/**
 * Expression bars for `n` rows. `rows[k][i]` is the row of the k-th leg of `legs`
 * (insertion order; the first leg is primary and supplies `time`) for output row
 * i, -1 = no value. Rows with any -1 or non-finite O/C are omitted. A leg row
 * equal to the one used by row i-1 is forward-filled and contributes
 * O=H=L=C=its close (row 0 always counts as fresh). Volume is 0.
 */
export function evalBarColumns(
  ast: ExprNode,
  legs: ReadonlyMap<string, BarColumnsLike>,
  rows: Int32Array[],
  n: number,
): BarColumns {
  const entries = [...legs];
  if (rows.length !== entries.length) {
    throw new Error(`evalBarColumns: ${rows.length} row arrays for ${entries.length} legs`);
  }
  const primary = entries[0];
  if (primary === undefined) throw new Error('evalBarColumns: no legs');

  // Keep rows where every leg has a value.
  const keep = new Int32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    let ok = true;
    for (const r of rows) {
      if ((r[i] ?? -1) < 0) {
        ok = false;
        break;
      }
    }
    if (ok) keep[m++] = i;
  }

  const fields = {
    open: new Map<string, Float64Array>(),
    high: new Map<string, Float64Array>(),
    low: new Map<string, Float64Array>(),
    close: new Map<string, Float64Array>(),
  };
  entries.forEach(([symbol, bars], k) => {
    const r = rows[k] as Int32Array;
    const o = new Float64Array(m);
    const h = new Float64Array(m);
    const l = new Float64Array(m);
    const c = new Float64Array(m);
    for (let q = 0; q < m; q++) {
      const i = keep[q] as number;
      const j = r[i] as number;
      const close = bars.close[j] ?? NaN;
      c[q] = close;
      if (i > 0 && r[i - 1] === j) {
        o[q] = close;
        h[q] = close;
        l[q] = close;
      } else {
        o[q] = bars.open[j] ?? NaN;
        h[q] = bars.high[j] ?? NaN;
        l[q] = bars.low[j] ?? NaN;
      }
    }
    fields.open.set(symbol, o);
    fields.high.set(symbol, h);
    fields.low.set(symbol, l);
    fields.close.set(symbol, c);
  });

  const fo = evalColumns(ast, fields.open, m);
  const fh = evalColumns(ast, fields.high, m);
  const fl = evalColumns(ast, fields.low, m);
  const fc = evalColumns(ast, fields.close, m);
  const pr = rows[0] as Int32Array;
  const out: BarColumns = {
    time: new Float64Array(m),
    open: new Float64Array(m),
    high: new Float64Array(m),
    low: new Float64Array(m),
    close: new Float64Array(m),
    volume: new Float64Array(m),
  };
  let w = 0;
  for (let q = 0; q < m; q++) {
    const bar = envelope(fo[q] ?? NaN, fh[q] ?? NaN, fl[q] ?? NaN, fc[q] ?? NaN);
    if (bar === null) continue;
    out.time[w] = primary[1].time[pr[keep[q] as number] as number] ?? NaN;
    out.open[w] = bar.open;
    out.high[w] = bar.high;
    out.low[w] = bar.low;
    out.close[w] = bar.close;
    w++;
  }
  if (w === m) return out;
  return {
    time: out.time.slice(0, w),
    open: out.open.slice(0, w),
    high: out.high.slice(0, w),
    low: out.low.slice(0, w),
    close: out.close.slice(0, w),
    volume: out.volume.slice(0, w),
  };
}
