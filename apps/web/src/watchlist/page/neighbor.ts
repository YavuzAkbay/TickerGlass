/**
 * Where the detail pane goes when `removed` leaves the list: the next row of
 * the order last displayed that still exists, else the previous one, else null
 * (close the pane).
 */
export function neighborAfterRemoval(
  order: readonly string[],
  removed: string,
  exists: (symbol: string) => boolean,
): string | null {
  const at = order.indexOf(removed);
  if (at < 0) return null;
  for (let i = at + 1; i < order.length; i++) if (exists(order[i]!)) return order[i]!;
  for (let i = at - 1; i >= 0; i--) if (exists(order[i]!)) return order[i]!;
  return null;
}
