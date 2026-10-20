/**
 * Splitter numerics for the layout grid (pure; the grid UI renders and
 * drags). Sizes are fractions of a split's content length that sum to
 * exactly 1. Minimums are enforced while dragging only; when the window is
 * too small cells shrink proportionally instead.
 */
import {
  equalSizes,
  exactSizes,
  sumOf,
  type GridNode,
  type GridSplit,
  type SplitDir,
} from './grid';

/** Smallest chart cell, px. */
export const CELL_MIN = { w: 180, h: 120 } as const;
/** Visible splitter thickness, px (its hit area is wider). */
export const SPLITTER_PX = 4;

/**
 * Smallest length of `node` along `axis` ('row': width, 'col': height): a
 * split along the axis needs every child's minimum plus the splitters
 * between them; across it, the largest child minimum; a leaf, the cell minimum.
 */
export function minExtent(
  node: GridNode,
  axis: SplitDir,
  cellMin: { w: number; h: number } = CELL_MIN,
  splitterPx = SPLITTER_PX,
): number {
  if (node.kind === 'leaf') return axis === 'row' ? cellMin.w : cellMin.h;
  const mins = node.children.map((c) => minExtent(c, axis, cellMin, splitterPx));
  return node.dir === axis
    ? sumOf(mins) + splitterPx * (node.children.length - 1)
    : Math.max(...mins);
}

/**
 * Move the boundary after child `k` by `dxPx` in a split `lenPx` long.
 * Only children k and k+1 change; each keeps at least its `mins` (px). When
 * the pair cannot fit both minimums the sizes are returned unchanged.
 */
export function dragSplitter(
  sizes: readonly number[],
  k: number,
  dxPx: number,
  lenPx: number,
  mins: readonly number[],
): number[] {
  const out = [...sizes];
  if (!(lenPx > 0) || !Number.isFinite(dxPx) || k < 0 || k + 1 >= sizes.length) return out;
  const pair = sizes[k]! + sizes[k + 1]!;
  const lo = (mins[k] ?? 0) / lenPx;
  const hi = pair - (mins[k + 1] ?? 0) / lenPx;
  if (lo > hi) return out;
  const a = Math.min(hi, Math.max(lo, sizes[k]! + dxPx / lenPx));
  out[k] = a;
  out[k + 1] = pair - a;
  return withRemainder(out);
}

/** `sizes` with the last entry absorbing rounding error, so they sum to exactly 1. */
function withRemainder(sizes: number[]): number[] {
  const head = sizes.slice(0, -1);
  return [...head, 1 - sumOf(head)];
}

const nodeAt = (root: GridNode, path: readonly number[]): GridNode | undefined => {
  let n: GridNode | undefined = root;
  for (const i of path) n = n?.kind === 'split' ? n.children[i] : undefined;
  return n;
};

/** `root` with the node at `path` replaced by `f(node)` (copies along the path). */
function updateAt(root: GridNode, path: readonly number[], f: (n: GridNode) => GridNode): GridNode {
  if (path.length === 0) return f(root);
  if (root.kind !== 'split') return root;
  const [i, ...rest] = path;
  const child = root.children[i!];
  if (!child) return root;
  const children = [...root.children];
  children[i!] = updateAt(child, rest, f);
  return { ...root, children };
}

const withSizes =
  (sizes: number[]) =>
  (n: GridNode): GridNode =>
    n.kind === 'split' && n.children.length === sizes.length ? { ...n, sizes: [...sizes] } : n;

/**
 * Set the sizes of the split at `path`. If its parent is aligned, sibling
 * splits with as many children get the same sizes (a uniform grid's columns
 * stay lined up). Paths are child indexes from the root.
 */
export function applyAligned(
  grid: GridNode,
  path: readonly number[],
  sizes: readonly number[],
): GridNode {
  const target = nodeAt(grid, path);
  if (target?.kind !== 'split' || target.children.length !== sizes.length) return grid;
  const exact = exactSizes(sizes);
  const parentPath = path.slice(0, -1);
  const parent = path.length > 0 ? nodeAt(grid, parentPath) : undefined;
  if (parent?.kind === 'split' && parent.aligned)
    return updateAt(grid, parentPath, (p) => {
      const sp = p as GridSplit;
      return { ...sp, children: sp.children.map(withSizes(exact)) };
    });
  return updateAt(grid, path, withSizes(exact));
}

/**
 * Equal sizes for the split at `path` (aligned siblings follow), or for every
 * split when `path` is omitted.
 */
export function equalise(grid: GridNode, path?: readonly number[]): GridNode {
  if (path) {
    const n = nodeAt(grid, path);
    return n?.kind === 'split' ? applyAligned(grid, path, equalSizes(n.children.length)) : grid;
  }
  const walk = (n: GridNode): GridNode =>
    n.kind === 'leaf'
      ? n
      : { ...n, sizes: equalSizes(n.children.length), children: n.children.map(walk) };
  return walk(grid);
}
