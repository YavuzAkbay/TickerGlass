/** The chart after (dir 1) or before (dir -1) `current` in `order`, wrapping; null when there are none. */
export function cycleFocus(
  order: readonly string[],
  current: string | null,
  dir: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at < 0) return dir > 0 ? order[0]! : order[order.length - 1]!;
  return order[(at + dir + order.length) % order.length]!;
}
