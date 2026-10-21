/**
 * The multi-chart layout tree (guillotine splits). A split lays its children
 * out along `dir` ('row': side by side, 'col': stacked) with `sizes` as
 * fractions summing to exactly 1. Directions alternate with depth; the
 * normaliser enforces this and every other invariant when a tree is parsed.
 */

export type SplitDir = 'row' | 'col';

export interface GridLeaf {
  kind: 'leaf';
  chartId: string;
}

export interface GridSplit {
  kind: 'split';
  dir: SplitDir;
  sizes: number[];
  children: GridNode[];
  /** Dragging a splitter in one child applies the same fractions to siblings with as many children. */
  aligned?: boolean;
}

export type GridNode = GridLeaf | GridSplit;

/** Which changes in one chart are mirrored to the others. */
export interface SyncFlags {
  symbol: boolean;
  interval: boolean;
  crosshair: boolean;
  time: boolean;
  dateRange: boolean;
  drawings: boolean;
}

export const DEFAULT_SYNC_FLAGS: SyncFlags = {
  symbol: false,
  interval: false,
  crosshair: true,
  time: false,
  dateRange: false,
  drawings: true,
};

const SYNC_KEYS = Object.keys(DEFAULT_SYNC_FLAGS) as (keyof SyncFlags)[];

/** Sync flags from stored data; missing or invalid flags take their default. */
export function parseSyncFlags(raw: unknown): SyncFlags {
  const o = isRecord(raw) ? raw : {};
  const out = { ...DEFAULT_SYNC_FLAGS };
  for (const k of SYNC_KEYS) if (typeof o[k] === 'boolean') out[k] = o[k];
  return out;
}

export const leaf = (chartId: string): GridLeaf => ({ kind: 'leaf', chartId });

/** Sum in index order (the order exactSizes balances against). */
export const sumOf = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * `sizes` scaled to sum to exactly 1: the last entry takes the remainder, so
 * float drift never accumulates. Non-positive or non-finite entries (or a
 * wrong total) fall back to equal shares.
 */
export function exactSizes(sizes: readonly number[]): number[] {
  const n = sizes.length;
  if (n === 0) return [];
  const ok = sizes.every((s) => Number.isFinite(s) && s > 0);
  const total = ok ? sumOf(sizes) : 0;
  const scaled = ok && total > 0 ? sizes.map((s) => s / total) : sizes.map(() => 1 / n);
  const head = scaled.slice(0, -1);
  return [...head, 1 - sumOf(head)];
}

/** Equal fractions for `n` children, summing to exactly 1. */
export const equalSizes = (n: number): number[] => exactSizes(Array.from({ length: n }, () => 1));

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A valid tree from stored data, or null when nothing valid is left.
 * - leaves need a non-empty chart id; with `validIds` it must be listed, and
 *   each id appears once (later duplicates are dropped);
 * - splits with no valid child are dropped, single-child splits collapse;
 * - a child split in its parent's direction is merged into the parent, so
 *   directions alternate;
 * - sizes are positive fractions summing to exactly 1 (equal when invalid).
 */
export function normalise(raw: unknown, validIds?: ReadonlySet<string>): GridNode | null {
  const seen = new Set<string>();
  const walk = (node: unknown): GridNode | null => {
    if (!isRecord(node)) return null;
    if (node.kind === 'leaf') {
      const id = node.chartId;
      if (typeof id !== 'string' || !id || seen.has(id) || (validIds && !validIds.has(id)))
        return null;
      seen.add(id);
      return leaf(id);
    }
    if (node.kind !== 'split' || !Array.isArray(node.children)) return null;
    const dir: SplitDir = node.dir === 'col' ? 'col' : 'row';
    const rawSizes = Array.isArray(node.sizes) ? node.sizes : [];
    const given =
      rawSizes.length === node.children.length &&
      rawSizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0)
        ? (rawSizes as number[])
        : node.children.map(() => 1);
    const children: GridNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((c, i) => {
      const n = walk(c);
      if (!n) return;
      if (n.kind === 'split' && n.dir === dir) {
        // Same direction as this split: merge its children in, scaled by its share.
        n.children.forEach((cc, j) => {
          children.push(cc);
          sizes.push(given[i]! * n.sizes[j]!);
        });
      } else {
        children.push(n);
        sizes.push(given[i]!);
      }
    });
    if (children.length === 0) return null;
    if (children.length === 1) return children[0]!;
    const out: GridSplit = { kind: 'split', dir, sizes: exactSizes(sizes), children };
    if (node.aligned === true) out.aligned = true;
    return out;
  };
  return walk(raw);
}

/** Chart ids of the leaves, in reading order. */
export function leaves(node: GridNode): string[] {
  return node.kind === 'leaf' ? [node.chartId] : node.children.flatMap(leaves);
}

/** `node` with each leaf's chart id replaced by `f(id, index)` (index in reading order). */
export function mapLeaves(node: GridNode, f: (chartId: string, index: number) => string): GridNode {
  let i = 0;
  const walk = (n: GridNode): GridNode =>
    n.kind === 'leaf'
      ? leaf(f(n.chartId, i++))
      : { ...n, sizes: [...n.sizes], children: n.children.map(walk) };
  return walk(node);
}

export interface TemplateChange {
  grid: GridNode;
  /** Ids given to leaves no existing chart filled (new charts to create). */
  created: string[];
  /** Existing charts left without a leaf (to remove, after the user confirms). */
  removed: string[];
}

/**
 * Switch to `template`'s arrangement: existing charts fill its leaves in
 * order (`existingChartIds` first, then any other leaf of `oldGrid`), extra
 * leaves get `newId()`, and charts left over are reported as removed.
 */
export function replaceTemplate(
  oldGrid: GridNode,
  template: GridNode,
  existingChartIds: readonly string[],
  newId: () => string,
): TemplateChange {
  const order = [...new Set([...existingChartIds, ...leaves(oldGrid)])];
  const created: string[] = [];
  const grid = mapLeaves(template, (_, i) => {
    if (i < order.length) return order[i]!;
    const id = newId();
    created.push(id);
    return id;
  });
  return { grid, created, removed: order.slice(leaves(template).length) };
}
