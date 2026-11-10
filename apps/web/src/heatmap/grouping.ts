/**
 * Grouping and aggregation (pure), shared by the heatmap's group headers and the screener table's
 * group rows.
 */

/** Mean of the finite values; null when there are none. */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values)
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  return n ? sum / n : null;
}

/** Weighted mean over entries with a finite value and a positive weight; null when none qualify. */
export function weightedMean(
  values: readonly (number | null | undefined)[],
  weights: readonly (number | null | undefined)[],
): number | null {
  let sum = 0;
  let w = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const x = weights[i];
    if (typeof v === 'number' && Number.isFinite(v) && typeof x === 'number' && x > 0) {
      sum += v * x;
      w += x;
    }
  }
  return w > 0 ? sum / w : null;
}

export interface Grouped<T> {
  key: string;
  rows: T[];
}

/**
 * Split `rows` by `keyOf`. Groups come in order of their first row and rows keep their input order,
 * so a sorted list stays sorted within every group (and the group holding the top row comes first).
 */
export function groupRows<T>(rows: readonly T[], keyOf: (row: T) => string): Grouped<T>[] {
  const byKey = new Map<string, Grouped<T>>();
  for (const row of rows) {
    const key = keyOf(row);
    let g = byKey.get(key);
    if (!g) {
      g = { key, rows: [] };
      byKey.set(key, g);
    }
    g.rows.push(row);
  }
  return [...byKey.values()];
}

export interface GroupAggregate {
  count: number;
  /** Plain mean of the members' change % (null: none known). */
  avgChange: number | null;
  /** Sum of the members' known market caps in USD (null: none known). */
  totalCap: number | null;
}

export function aggregate(
  members: readonly { change: number | null; cap: number | null }[],
): GroupAggregate {
  let total = 0;
  let any = false;
  for (const m of members)
    if (typeof m.cap === 'number' && Number.isFinite(m.cap) && m.cap > 0) {
      total += m.cap;
      any = true;
    }
  return {
    count: members.length,
    avgChange: mean(members.map((m) => m.change)),
    totalCap: any ? total : null,
  };
}

/** One line of a grouped table: a group header (with its aggregate) or a member row. */
export type GroupEntry<T> =
  | { kind: 'group'; key: string; agg: GroupAggregate; collapsed: boolean }
  | { kind: 'row'; row: T; group: string };

/** Flatten groups into table lines; the rows of a collapsed group are left out. */
export function groupEntries<T>(
  groups: readonly Grouped<T>[],
  collapsed: ReadonlySet<string>,
  aggregateOf: (rows: readonly T[]) => GroupAggregate,
): GroupEntry<T>[] {
  const out: GroupEntry<T>[] = [];
  for (const g of groups) {
    const isCollapsed = collapsed.has(g.key);
    out.push({ kind: 'group', key: g.key, agg: aggregateOf(g.rows), collapsed: isCollapsed });
    if (!isCollapsed) for (const row of g.rows) out.push({ kind: 'row', row, group: g.key });
  }
  return out;
}
