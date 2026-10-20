import { describe, expect, it } from 'vitest';
import { cssLen, evalLen, gridGeometry, thumbCells } from './geometry';
import { dragSplitter } from './splitter';
import { template } from './templates';
import { leaves } from './grid';

const W = 1000;
const H = 600;

describe('grid geometry', () => {
  it('tiles the container: cells and splitters leave no gaps or overlaps', () => {
    for (const key of ['2x2', '1L+4', '3+2', 'rows-11']) {
      const tree = template(key)!;
      const { cells, splitters } = gridGeometry(tree);
      expect(cells.map((c) => c.chartId)).toEqual(leaves(tree));
      // Cell area plus splitter area covers the container exactly.
      const area = (b: (typeof cells)[number]['box']) => evalLen(b.w, W) * evalLen(b.h, H);
      const total =
        cells.reduce((a, c) => a + area(c.box), 0) + splitters.reduce((a, s) => a + area(s.box), 0);
      // Splitters crossing a splitter of the other direction are counted once per
      // branch, so the cells + splitters cover at least the container and at most it.
      expect(total).toBeCloseTo(W * H, 3);
    }
  });

  it('a 2x2 grid puts four equal cells around 4px splitters', () => {
    const { cells, splitters } = gridGeometry(template('2x2')!);
    const first = cells[0]!.box;
    expect(evalLen(first.w, W)).toBeCloseTo((W - 4) / 2);
    expect(evalLen(first.h, H)).toBeCloseTo((H - 4) / 2);
    expect(evalLen(cells[1]!.box.x, W)).toBeCloseTo((W - 4) / 2 + 4);
    expect(splitters.filter((s) => s.dir === 'col')).toHaveLength(1);
    expect(splitters.filter((s) => s.dir === 'row')).toHaveLength(2);
  });

  it('formats lengths as CSS', () => {
    expect(cssLen({ pct: 50, px: 0 })).toBe('50%');
    expect(cssLen({ pct: 25, px: -3 })).toBe('calc(25% + -3px)');
  });

  it('thumbnail cells are percent rectangles in reading order', () => {
    const cells = thumbCells(template('1L+2')!);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toEqual({ x: 0, y: 0, w: 50, h: 100 });
    expect(cells[1]).toEqual({ x: 50, y: 0, w: 50, h: 50 });
    expect(cells[2]).toEqual({ x: 50, y: 50, w: 50, h: 50 });
  });

  it('a splitter reports the split length it moves along', () => {
    const { splitters } = gridGeometry(template('2c')!);
    expect(splitters).toHaveLength(1);
    const s = splitters[0]!;
    const len = evalLen(s.length, W);
    expect(len).toBe(W);
    const sizes = dragSplitter([0.5, 0.5], s.index, 100, len - 4, [180, 180]);
    expect(sizes[0]).toBeCloseTo(0.5 + 100 / (len - 4));
  });
});
