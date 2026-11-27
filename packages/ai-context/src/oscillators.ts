/**
 * RSI and MACD computed in place, so the AI can look for divergences without adding an
 * indicator to the user's chart. Same formulas as the built-ins (Wilder RSI, EMA MACD).
 */
import { at } from './format';

/** Wilder RSI of `close` (RMA of gains and losses, seeded with their simple average). */
export function rsi(close: ArrayLike<number>, length = 14): Float64Array {
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n <= length) return out;
  let up = 0;
  let down = 0;
  for (let i = 1; i <= length; i++) {
    const ch = at(close, i) - at(close, i - 1);
    up += Math.max(ch, 0);
    down += Math.max(-ch, 0);
  }
  up /= length;
  down /= length;
  const value = (u: number, d: number) => (d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d));
  out[length] = value(up, down);
  for (let i = length + 1; i < n; i++) {
    const ch = at(close, i) - at(close, i - 1);
    up = (up * (length - 1) + Math.max(ch, 0)) / length;
    down = (down * (length - 1) + Math.max(-ch, 0)) / length;
    out[i] = value(up, down);
  }
  return out;
}

function ema(values: ArrayLike<number>, length: number): Float64Array {
  const out = new Float64Array(values.length).fill(NaN);
  const k = 2 / (length + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = at(values, i);
    if (!Number.isFinite(v)) continue;
    prev = Number.isFinite(prev) ? v * k + prev * (1 - k) : v;
    out[i] = prev;
  }
  return out;
}

/** MACD line (fast EMA − slow EMA) of `close`, NaN until the slow EMA has warmed up. */
export function macdLine(close: ArrayLike<number>, fast = 12, slow = 26): Float64Array {
  const f = ema(close, fast);
  const s = ema(close, slow);
  const out = new Float64Array(close.length).fill(NaN);
  for (let i = slow - 1; i < close.length; i++) out[i] = f[i]! - s[i]!;
  return out;
}

/** MACD histogram (MACD line − its signal EMA), the usual series for MACD divergences. */
export function macdHistogram(
  close: ArrayLike<number>,
  fast = 12,
  slow = 26,
  signal = 9,
): Float64Array {
  const line = macdLine(close, fast, slow);
  const sig = ema(line, signal);
  const out = new Float64Array(close.length).fill(NaN);
  for (let i = 0; i < close.length; i++)
    if (Number.isFinite(line[i]!) && Number.isFinite(sig[i]!)) out[i] = line[i]! - sig[i]!;
  return out;
}
