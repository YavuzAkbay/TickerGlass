import { describe, expect, it } from 'vitest';
import { equalSizes, leaf, sumOf, type GridNode, type GridSplit } from './grid';
import { applyAligned, CELL_MIN, dragSplitter, equalise, minExtent, SPLITTER_PX } from './splitter';
import { template } from './templates';

/** Deterministic PRNG (mulberry32), so failures reproduce. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('minExtent', () => {
  it('sums along the split axis and takes the max across it', () => {
    expect(minExtent(leaf('a'), 'row')).toBe(CELL_MIN.w);
    expect(minExtent(leaf('a'), 'col')).toBe(CELL_MIN.h);
    const three = template('3c')!;
    expect(minExtent(three, 'row')).toBe(3 * 180 + 2 * SPLITTER_PX);
    expect(minExtent(three, 'col')).toBe(120);
    // 1L+2: a leaf beside two stacked charts.
    const l2 = template('1L+2')!;
    expect(minExtent(l2, 'row')).toBe(2 * 180 + 4);
    expect(minExtent(l2, 'col')).toBe(2 * 120 + 4);
    expect(minExtent(template('4x4')!, 'row', { w: 10, h: 5 }, 2)).toBe(4 * 10 + 3 * 2);
  });
});

describe('dragSplitter', () => {
  it('moves the boundary between two neighbours only', () => {
    const out = dragSplitter([0.25, 0.25, 0.5], 0, 100, 1000, [0, 0, 0]);
    expect(out[0]).toBeCloseTo(0.35);
    expect(out[1]).toBeCloseTo(0.15);
    expect(out[2]).toBe(0.5);
    expect(sumOf(out)).toBe(1);
  });

  it('clamps at the neighbours’ minimums', () => {
    const mins = [180, 180];
    const right = dragSplitter([0.5, 0.5], 0, 10_000, 1000, mins);
    expect(right[0]).toBeCloseTo(0.82);
    expect(sumOf(right)).toBe(1);
    expect(dragSplitter([0.5, 0.5], 0, -10_000, 1000, mins)[0]).toBeCloseTo(0.18);
    // Cannot fit both minimums: unchanged.
    expect(dragSplitter([0.5, 0.5], 0, 50, 300, mins)).toEqual([0.5, 0.5]);
    // Invalid boundary or length: unchanged copy.
    expect(dragSplitter([0.5, 0.5], 1, 50, 1000, mins)).toEqual([0.5, 0.5]);
    expect(dragSplitter([0.5, 0.5], 0, 50, 0, mins)).toEqual([0.5, 0.5]);
  });

  it('keeps the sum exactly 1 and the minimums under many random drags', () => {
    const rand = rng(42);
    for (let trial = 0; trial < 50; trial++) {
      const n = 2 + Math.floor(rand() * 6);
      const len = 1200 + Math.floor(rand() * 2000);
      const mins = Array.from({ length: n }, () => 120);
      let sizes = equalSizes(n);
      for (let i = 0; i < 400; i++) {
        const k = Math.floor(rand() * (n - 1));
        sizes = dragSplitter(sizes, k, (rand() - 0.5) * 900, len, mins);
        expect(sumOf(sizes)).toBe(1);
        for (const s of sizes) expect(s * len).toBeGreaterThanOrEqual(120 - 1e-6);
      }
    }
  });
});

describe('applyAligned / equalise', () => {
  const row = (g: GridNode, i: number) => (g as GridSplit).children[i] as GridSplit;

  it('propagates to sibling rows with as many children in an aligned grid', () => {
    const g = template('3x3')!;
    const next = applyAligned(g, [1], [0.5, 0.25, 0.25]);
    for (let i = 0; i < 3; i++) expect(row(next, i).sizes).toEqual([0.5, 0.25, 0.25]);
    expect(row(g, 0).sizes).toEqual(equalSizes(3)); // input untouched
  });

  it('changes only the target when the parent is not aligned', () => {
    const g = template('3+2')!;
    const next = applyAligned(g, [0], [0.5, 0.25, 0.25]);
    expect(row(next, 0).sizes).toEqual([0.5, 0.25, 0.25]);
    expect(row(next, 1).sizes).toEqual([0.5, 0.5]);
  });

  it('skips siblings with a different child count and ignores bad paths or lengths', () => {
    const g: GridNode = {
      kind: 'split',
      dir: 'col',
      aligned: true,
      sizes: [0.5, 0.5],
      children: [
        { kind: 'split', dir: 'row', sizes: [0.5, 0.5], children: [leaf('a'), leaf('b')] },
        {
          kind: 'split',
          dir: 'row',
          sizes: equalSizes(3),
          children: [leaf('c'), leaf('d'), leaf('e')],
        },
      ],
    };
    const next = applyAligned(g, [0], [0.3, 0.7]);
    expect(row(next, 0).sizes[0]).toBeCloseTo(0.3);
    expect(row(next, 1).sizes).toEqual(equalSizes(3));
    expect(applyAligned(g, [0], [1])).toBe(g);
    expect(applyAligned(g, [5], [0.5, 0.5])).toBe(g);
  });

  it('sets the root sizes and equalises', () => {
    const g = template('2c')!;
    const moved = applyAligned(g, [], [0.7, 0.3]);
    expect((moved as GridSplit).sizes[0]).toBeCloseTo(0.7);
    expect(equalise(moved, [])).toEqual(g);
    const grid = applyAligned(template('2x2')!, [0], [0.9, 0.1]);
    expect(equalise(grid)).toEqual(template('2x2'));
    expect(equalise(grid, [1])).toEqual(template('2x2'));
  });
});
