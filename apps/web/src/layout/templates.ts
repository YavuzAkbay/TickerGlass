/**
 * Grid templates for 1..16 charts. A hand-picked set covers the common
 * arrangements (side by side, stacked, one large chart with context charts,
 * uniform grids); any other count gets generated balanced rows. Template
 * leaves carry placeholder ids (`slot-0`, ...) that replaceTemplate() fills
 * with chart ids. The template id is only a label for the picker: layouts
 * store the resolved tree.
 *
 * Naming: `Nc` N columns side by side, `Nr` N rows stacked, `AxB` A columns
 * by B rows, `A+B` a row of A above a row of B, `1L+N` one large chart on the
 * left with N on the right, `2+1B` two above one at the bottom.
 */
import { equalSizes, leaf, normalise, type GridNode, type GridSplit, type SplitDir } from './grid';

export const MAX_CHARTS = 16;

export interface TemplateInfo {
  id: string;
  /** Number of charts (leaves). */
  count: number;
}

type Shape = (next: () => GridNode) => GridNode;

const split = (dir: SplitDir, children: GridNode[], aligned = false): GridSplit => ({
  kind: 'split',
  dir,
  sizes: equalSizes(children.length),
  children,
  ...(aligned ? { aligned: true } : {}),
});

const line =
  (dir: SplitDir, n: number): Shape =>
  (next) =>
    split(
      dir,
      Array.from({ length: n }, () => next()),
    );

/** Stacked rows with `counts[i]` charts each; aligned when every row has as many. */
const rows =
  (counts: number[]): Shape =>
  (next) =>
    split(
      'col',
      counts.map((c) => line('row', c)(next)),
      counts.every((c) => c === counts[0]),
    );

/** `cols` columns by `nRows` rows. */
const grid = (cols: number, nRows: number): Shape =>
  rows(Array.from({ length: nRows }, () => cols));

/** One large chart on the left, `right` beside it. */
const largeLeft =
  (right: Shape): Shape =>
  (next) =>
    split('row', [next(), right(next)]);

const HAND_PICKED: [string, Shape][] = [
  ['1', (next) => next()],
  ['2c', line('row', 2)],
  ['2r', line('col', 2)],
  ['3c', line('row', 3)],
  ['3r', line('col', 3)],
  ['1L+2', largeLeft(line('col', 2))],
  ['2+1B', (next) => split('col', [line('row', 2)(next), next()])],
  ['2x2', grid(2, 2)],
  ['4c', line('row', 4)],
  ['1L+3', largeLeft(line('col', 3))],
  ['3+2', rows([3, 2])],
  // Four context charts as a 2x2 block: landscape cells next to the large one.
  ['1L+4', largeLeft(grid(2, 2))],
  ['3x2', grid(3, 2)],
  ['2x3', grid(2, 3)],
  ['4+3', rows([4, 3])],
  ['4x2', grid(4, 2)],
  ['2x4', grid(2, 4)],
  ['3x3', grid(3, 3)],
  ['5x2', grid(5, 2)],
  ['4x3', grid(4, 3)],
  ['3x4', grid(3, 4)],
  ['4x4', grid(4, 4)],
];

/**
 * Charts per row for `n` charts: floor(sqrt(n)) rows (wider than tall, so
 * cells stay landscape), counts differing by at most one, fuller rows first
 * (11 -> 4,4,3; 13 -> 5,4,4; 14 -> 5,5,4; 15 -> 5,5,5).
 */
export function balancedRows(n: number): number[] {
  const r = Math.max(1, Math.floor(Math.sqrt(n)));
  const base = Math.floor(n / r);
  const extra = n % r;
  return Array.from({ length: r }, (_, i) => base + (i < extra ? 1 : 0));
}

const GENERATED_PREFIX = 'rows-';

const build = (shape: Shape): GridNode => {
  let i = 0;
  // Template shapes are valid by construction; normalise only canonicalises.
  return normalise(shape(() => leaf(`slot-${i++}`)))!;
};

const countOf = (shape: Shape): number => {
  let i = 0;
  shape(() => leaf(`slot-${i++}`));
  return i;
};

const SHAPES = new Map<string, Shape>(HAND_PICKED);
for (let n = 1; n <= MAX_CHARTS; n++)
  if (!HAND_PICKED.some(([, s]) => countOf(s) === n)) {
    const counts = balancedRows(n);
    SHAPES.set(`${GENERATED_PREFIX}${n}`, counts.length === 1 ? line('row', n) : rows(counts));
  }

/** Every template for the picker, by chart count (hand-picked order within a count). */
export const TEMPLATES: readonly TemplateInfo[] = [...SHAPES]
  .map(([id, shape]) => ({ id, count: countOf(shape) }))
  .sort((a, b) => a.count - b.count);

/**
 * The tree of template `key` (an id, or a chart count for its first
 * template), with placeholder leaf ids; null if unknown or out of range.
 */
export function template(key: string | number): GridNode | null {
  const id =
    typeof key === 'number' ? TEMPLATES.find((t) => t.count === key)?.id : SHAPES.has(key) && key;
  const shape = id ? SHAPES.get(id) : undefined;
  return shape ? build(shape) : null;
}

/** Id of the first template for `n` charts (null outside 1..16). */
export const templateIdFor = (n: number): string | null =>
  TEMPLATES.find((t) => t.count === n)?.id ?? null;
