/**
 * Where the grid's cells and splitters sit (pure). Positions are linear in
 * the container size, so each is a `Len`: a percentage of the container plus a
 * pixel offset (the splitters' thickness), written as one CSS calc(). Cells
 * are laid out absolutely from the tree instead of nesting elements per
 * split: a template change that moves a chart to another branch then keeps its
 * element (and its engine chart) alive.
 */
import { SPLITTER_PX } from './splitter';
import type { GridNode, SplitDir } from './grid';

/** `pct`% of the container length plus `px` pixels. */
export interface Len {
  pct: number;
  px: number;
}

export interface Box {
  x: Len;
  y: Len;
  w: Len;
  h: Len;
}

export interface CellGeometry {
  chartId: string;
  box: Box;
}

export interface SplitterGeometry {
  /** Child indexes from the root to the split this splitter belongs to. */
  path: number[];
  /** The boundary after child `index`. */
  index: number;
  dir: SplitDir;
  box: Box;
  /** The split's length along its axis (`dir`), splitters included. */
  length: Len;
}

const add = (a: Len, b: Len): Len => ({ pct: a.pct + b.pct, px: a.px + b.px });
const scale = (a: Len, k: number): Len => ({ pct: a.pct * k, px: a.px * k });
const px = (n: number): Len => ({ pct: 0, px: n });
const ZERO: Len = px(0);

/** `len` in pixels for a container `total` px long. */
export const evalLen = (len: Len, total: number): number => (len.pct / 100) * total + len.px;

/** CSS length of `len`. */
export const cssLen = (len: Len): string =>
  len.px === 0 ? `${len.pct}%` : `calc(${len.pct}% + ${len.px}px)`;

export function gridGeometry(
  root: GridNode,
  splitterPx: number = SPLITTER_PX,
): { cells: CellGeometry[]; splitters: SplitterGeometry[] } {
  const cells: CellGeometry[] = [];
  const splitters: SplitterGeometry[] = [];
  const walk = (node: GridNode, box: Box, path: number[]) => {
    if (node.kind === 'leaf') {
      cells.push({ chartId: node.chartId, box });
      return;
    }
    const row = node.dir === 'row';
    const length = row ? box.w : box.h;
    const content = add(length, px(-(node.children.length - 1) * splitterPx));
    let cursor = row ? box.x : box.y;
    node.children.forEach((child, i) => {
      const size = scale(content, node.sizes[i]!);
      walk(child, row ? { ...box, x: cursor, w: size } : { ...box, y: cursor, h: size }, [
        ...path,
        i,
      ]);
      cursor = add(cursor, size);
      if (i < node.children.length - 1) {
        splitters.push({
          path,
          index: i,
          dir: node.dir,
          box: row
            ? { ...box, x: cursor, w: px(splitterPx) }
            : { ...box, y: cursor, h: px(splitterPx) },
          length,
        });
        cursor = add(cursor, px(splitterPx));
      }
    });
  };
  walk(root, { x: ZERO, y: ZERO, w: { pct: 100, px: 0 }, h: { pct: 100, px: 0 } }, []);
  return { cells, splitters };
}

export interface ThumbCell {
  /** Percent of the thumbnail. */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Cell rectangles of `grid` in percent, in reading order (for layout picker thumbnails). */
export function thumbCells(grid: GridNode): ThumbCell[] {
  return gridGeometry(grid, 0).cells.map(({ box }) => ({
    x: evalLen(box.x, 100),
    y: evalLen(box.y, 100),
    w: evalLen(box.w, 100),
    h: evalLen(box.h, 100),
  }));
}
