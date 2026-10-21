const MINUS = '−';

function decimalsOf(x: number, max: number): number {
  for (let d = 0; d <= max; d++) {
    const v = x * 10 ** d;
    if (Math.abs(v - Math.round(v)) < 1e-9 * Math.max(1, Math.abs(v))) return d;
  }
  return max;
}

/** A step of 1/2/2.5/5 x 10^k that yields roughly `targetCount` ticks over `range`. */
export function niceStep(range: number, targetCount: number): number {
  if (!(range > 0) || !Number.isFinite(range)) return 1;
  const raw = range / Math.max(1, targetCount);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  let m: number;
  if (norm < 1.5) m = 1;
  else if (norm < 2.25) m = 2;
  else if (norm < 3.5) m = 2.5;
  else if (norm < 7) m = 5;
  else m = 10;
  return m * mag;
}

/** Multiples of the nice step within [min, max], rounded to avoid float drift. */
export function linearTicks(min: number, max: number, targetCount: number): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
  if (max === min) return [min];
  const step = niceStep(max - min, targetCount);
  const decimals = decimalsOf(step, 12);
  const first = Math.ceil(min / step - 1e-9);
  const last = Math.floor(max / step + 1e-9);
  const out: number[] = [];
  for (let i = first; i <= last && out.length < 1000; i++) {
    out.push(Number((i * step).toFixed(decimals)));
  }
  return out;
}

function pow10(k: number): number {
  return Number(`1e${k}`);
}

/** Ticks for a log axis (price space, min and max positive). */
export function logTicks(min: number, max: number, targetCount: number): number[] {
  if (!(min > 0) || !(max >= min) || !Number.isFinite(max)) return [];
  const decades = Math.log10(max / min);
  if (decades < 2) return linearTicks(min, max, targetCount);

  const k0 = Math.floor(Math.log10(min));
  const k1 = Math.ceil(Math.log10(max));
  const gather = (mults: readonly number[], stride: number): number[] => {
    const out: number[] = [];
    for (let k = k0; k <= k1; k++) {
      if ((k - k0) % stride !== 0) continue;
      for (const m of mults) {
        const v = m * pow10(k);
        if (v >= min * (1 - 1e-12) && v <= max * (1 + 1e-12)) out.push(v);
      }
    }
    return out;
  };
  const limit = Math.max(2, Math.round(targetCount * 1.5));
  let ticks = gather([1, 2, 5], 1);
  if (ticks.length <= limit) return ticks;
  ticks = gather([1], 1);
  if (ticks.length <= limit) return ticks;
  return gather([1], Math.ceil(ticks.length / Math.max(1, targetCount)));
}

/**
 * Mantissa levels, coarsest first. A level is either an explicit mantissa list
 * (per decade) or a uniform mantissa step (per decade, mantissa in [1, 10)).
 */
const LOG_LEVELS: ReadonlyArray<{ mults?: readonly number[]; step?: number }> = [
  { mults: [1] },
  { mults: [1, 2, 5] },
  { step: 1 },
  { step: 0.5 },
  { step: 0.2 },
  { step: 0.1 },
  { step: 0.05 },
  { step: 0.02 },
  { step: 0.01 },
  { step: 0.005 },
  { step: 0.002 },
  { step: 0.001 },
];

/** Max candidates generated per level; finer levels beyond this are skipped. */
const LOG_LEVEL_CAP = 400;

function cleanValue(v: number): number {
  return Number(v.toPrecision(12));
}

function logLevelCandidates(
  min: number,
  max: number,
  level: { mults?: readonly number[]; step?: number },
): number[] | null {
  const k0 = Math.floor(Math.log10(min));
  const k1 = Math.floor(Math.log10(max));
  const out: number[] = [];
  const lo = min * (1 - 1e-12);
  const hi = max * (1 + 1e-12);
  for (let k = k0; k <= k1; k++) {
    const base = pow10(k);
    if (level.mults) {
      for (const m of level.mults) {
        const v = cleanValue(m * base);
        if (v >= lo && v <= hi) out.push(v);
      }
    } else if (level.step) {
      const step = level.step * base;
      const from = Math.max(Math.ceil(lo / step - 1e-9), Math.round(base / step));
      const to = Math.min(Math.floor(hi / step + 1e-9), Math.round((base * 10) / step) - 1);
      if (to - from + 1 + out.length > LOG_LEVEL_CAP) return null;
      for (let i = from; i <= to; i++) out.push(cleanValue(i * step));
    }
    if (out.length > LOG_LEVEL_CAP) return null;
  }
  return out;
}

/**
 * Pixel-aware ticks for a log axis. Candidates are tried from the coarsest
 * level (powers of 10) to ever finer 1/2/5-style levels; a candidate is kept
 * only if its pixel position is at least `minSpacingPx` from every kept tick.
 * Dense steps appear where the axis has room, coarse ones where it is compressed.
 * Returns ascending prices.
 */
export function logTicksSpaced(
  min: number,
  max: number,
  minSpacingPx: number,
  priceToY: (price: number) => number,
): number[] {
  if (!(min > 0) || !(max >= min) || !Number.isFinite(max)) return [];
  if (max === min) return [min];
  const gap = Math.max(1, minSpacingPx);
  const accepted: number[] = [];
  const ys: number[] = [];
  for (const level of LOG_LEVELS) {
    const cands = logLevelCandidates(min, max, level);
    if (!cands) break;
    for (const v of cands) {
      const y = priceToY(v);
      if (!Number.isFinite(y)) continue;
      let ok = true;
      for (const other of ys) {
        if (Math.abs(other - y) < gap) {
          ok = false;
          break;
        }
      }
      if (ok) {
        accepted.push(v);
        ys.push(y);
      }
    }
  }
  return accepted.sort((a, b) => a - b);
}

/** Decimal places needed to represent `minTick` (0.01 -> 2, 0.25 -> 2, 1 -> 0). */
export function decimalsForMinTick(minTick: number): number {
  if (!(minTick > 0) || !Number.isFinite(minTick)) return 2;
  return decimalsOf(minTick, 10);
}

function signed(s: string, negative: boolean): string {
  return negative ? MINUS + s : s;
}

/** Fixed decimals, U+2212 minus for negatives, no thousands separators. */
export function formatPrice(p: number, decimals: number): string {
  if (!Number.isFinite(p)) return '';
  const s = Math.abs(p).toFixed(decimals);
  return signed(s, p < 0 && /[1-9]/.test(s));
}

const VOLUME_UNITS: ReadonlyArray<readonly [number, string]> = [
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
];

function trim(n: number): string {
  return String(Number(n.toFixed(2)));
}

/** Compact volume: 999, 1.5K, 2.35M, 1.2B. */
export function formatVolume(v: number): string {
  if (!Number.isFinite(v)) return '';
  const a = Math.abs(v);
  const neg = v < 0;
  for (let i = 0; i < VOLUME_UNITS.length; i++) {
    const [div, suffix] = VOLUME_UNITS[i] as readonly [number, string];
    if (a >= div) {
      let scaled = Number((a / div).toFixed(2));
      let unit = suffix;
      if (scaled >= 1000 && i > 0) {
        const [d2, s2] = VOLUME_UNITS[i - 1] as readonly [number, string];
        scaled = Number((a / d2).toFixed(2));
        unit = s2;
      }
      return signed(String(scaled) + unit, neg);
    }
  }
  return signed(trim(a), neg && Number(trim(a)) !== 0);
}

/** Signed percent, e.g. `+1.23%` or `−0.50%`. */
export function formatPercent(p: number, decimals = 2): string {
  if (!Number.isFinite(p)) return '';
  const s = Math.abs(p).toFixed(decimals);
  if (!/[1-9]/.test(s)) return `${s}%`;
  return `${p < 0 ? MINUS : '+'}${s}%`;
}
