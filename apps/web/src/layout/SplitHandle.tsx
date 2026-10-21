import { useRef } from 'react';
import { cssLen, evalLen, type SplitterGeometry } from './geometry';
import type { GridNode } from './grid';
import { applyAligned, dragSplitter, equalise, minExtent } from './splitter';
import { useLayoutGrid } from './store';

const KEY_STEP_PX = 16;

const nodeAt = (root: GridNode, path: readonly number[]): GridNode | undefined => {
  let n: GridNode | undefined = root;
  for (const i of path) n = n?.kind === 'split' ? n.children[i] : undefined;
  return n;
};

/**
 * Move boundary `g.index` of the split at `g.path` by `dxPx`, starting from
 * `startGrid`, and write the result to the layout store (which autosaves).
 */
function moveBoundary(g: SplitterGeometry, startGrid: GridNode, dxPx: number, lenPx: number) {
  const split = nodeAt(startGrid, g.path);
  if (split?.kind !== 'split') return;
  const mins = split.children.map((c) => minExtent(c, g.dir));
  const sizes = dragSplitter(split.sizes, g.index, dxPx, lenPx, mins);
  useLayoutGrid.setState({ grid: applyAligned(startGrid, g.path, sizes) });
}

/** The 4px divider between two cells (8px hit area): drag to resize, double-click to equalise. */
export function SplitHandle({ geometry: g }: { geometry: SplitterGeometry }) {
  const drag = useRef<{ x: number; y: number; grid: GridNode; len: number } | null>(null);
  const row = g.dir === 'row';

  const lengthPx = (el: HTMLElement) => {
    const parent = el.parentElement!.getBoundingClientRect();
    return evalLen(g.length, row ? parent.width : parent.height);
  };

  return (
    <div
      className={`grid-splitter ${row ? 'vertical' : 'horizontal'}`}
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      tabIndex={0}
      style={{
        left: cssLen(g.box.x),
        top: cssLen(g.box.y),
        width: cssLen(g.box.w),
        height: cssLen(g.box.h),
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          grid: useLayoutGrid.getState().grid,
          len: lengthPx(e.currentTarget),
        };
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (d) moveBoundary(g, d.grid, row ? e.clientX - d.x : e.clientY - d.y, d.len);
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={() => useLayoutGrid.setState((s) => ({ grid: equalise(s.grid, g.path) }))}
      onKeyDown={(e) => {
        const back = e.key === (row ? 'ArrowLeft' : 'ArrowUp');
        const forward = e.key === (row ? 'ArrowRight' : 'ArrowDown');
        if (!back && !forward) return;
        e.preventDefault();
        moveBoundary(
          g,
          useLayoutGrid.getState().grid,
          forward ? KEY_STEP_PX : -KEY_STEP_PX,
          lengthPx(e.currentTarget),
        );
      }}
    />
  );
}
