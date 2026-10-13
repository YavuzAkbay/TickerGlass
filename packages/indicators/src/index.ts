/** Simple moving average. Leading values without a full window are NaN. */
export function sma(source: ArrayLike<number>, length: number): Float64Array {
  const out = new Float64Array(source.length).fill(NaN);
  if (length <= 0) return out;
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    sum += source[i]!;
    if (i >= length) sum -= source[i - length]!;
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}
