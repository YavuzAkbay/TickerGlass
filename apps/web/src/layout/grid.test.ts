import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_FLAGS,
  equalSizes,
  exactSizes,
  leaf,
  leaves,
  normalise,
  parseSyncFlags,
  replaceTemplate,
  sumOf,
  type GridNode,
  type GridSplit,
} from './grid';
import { template } from './templates';

const split = (dir: 'row' | 'col', children: GridNode[], sizes?: number[]): GridSplit => ({
  kind: 'split',
  dir,
  sizes: sizes ?? equalSizes(children.length),
  children,
});

/** Every split's sizes sum to exactly 1 and directions alternate. */
function checkInvariants(node: GridNode, parentDir?: string): void {
  if (node.kind === 'leaf') return;
  expect(node.children.length).toBeGreaterThan(1);
  expect(node.sizes).toHaveLength(node.children.length);
  expect(sumOf(node.sizes)).toBe(1);
  expect(node.dir).not.toBe(parentDir);
  for (const c of node.children) checkInvariants(c, node.dir);
}

describe('grid sizes', () => {
  it('exactSizes scales to exactly 1 and falls back to equal shares', () => {
    expect(sumOf(exactSizes([0.1, 0.2, 0.3]))).toBe(1);
    expect(exactSizes([1, 1, 2])).toEqual([0.25, 0.25, 0.5]);
    expect(exactSizes([1, -1])).toEqual([0.5, 0.5]);
    expect(exactSizes([NaN, 1])).toEqual([0.5, 0.5]);
    for (let n = 1; n <= 16; n++) expect(sumOf(equalSizes(n))).toBe(1);
  });
});

describe('normalise', () => {
  it('keeps a valid tree unchanged', () => {
    const g = split('col', [split('row', [leaf('a'), leaf('b')]), leaf('c')], [0.6, 0.4]);
    expect(normalise(g)).toEqual(g);
  });

  it('merges same-direction children so directions alternate', () => {
    const g = split('row', [leaf('a'), split('row', [leaf('b'), leaf('c')], [0.25, 0.75])]);
    const n = normalise(g) as GridSplit;
    expect(n.dir).toBe('row');
    expect(leaves(n)).toEqual(['a', 'b', 'c']);
    expect(n.sizes[0]).toBeCloseTo(0.5);
    expect(n.sizes[1]).toBeCloseTo(0.125);
    expect(n.sizes[2]).toBeCloseTo(0.375);
    checkInvariants(n);
  });

  it('collapses single-child splits and then merges with the parent', () => {
    const g = split('row', [leaf('a'), split('col', [split('row', [leaf('b'), leaf('c')])])]);
    const n = normalise(g) as GridSplit;
    expect(n.children).toHaveLength(3);
    checkInvariants(n);
    expect(normalise(split('col', [leaf('x')]))).toEqual(leaf('x'));
  });

  it('drops invalid nodes, unknown and duplicate ids; fixes sizes', () => {
    const raw = {
      kind: 'split',
      dir: 'diagonal',
      sizes: [0.5, 'x', 0.5],
      children: [leaf('a'), { kind: 'leaf', chartId: '' }, leaf('a'), leaf('zz'), 7, leaf('b')],
      aligned: 'yes',
    };
    const n = normalise(raw, new Set(['a', 'b'])) as GridSplit;
    expect(n).toEqual({
      kind: 'split',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [leaf('a'), leaf('b')],
    });
    expect(normalise(null)).toBeNull();
    expect(normalise({ kind: 'split', dir: 'row', sizes: [], children: [] })).toBeNull();
    expect(normalise(leaf('q'), new Set(['a']))).toBeNull();
  });

  it('keeps aligned and renormalises sizes that do not sum to 1', () => {
    const n = normalise({ ...split('row', [leaf('a'), leaf('b')], [2, 6]), aligned: true });
    expect(n).toEqual({ ...split('row', [leaf('a'), leaf('b')], [0.25, 0.75]), aligned: true });
  });

  it('is idempotent', () => {
    for (let k = 1; k <= 16; k++) {
      const t = template(k)!;
      expect(normalise(t)).toEqual(t);
      checkInvariants(t);
    }
  });
});

describe('sync flags', () => {
  it('defaults missing or invalid flags', () => {
    expect(parseSyncFlags(undefined)).toEqual(DEFAULT_SYNC_FLAGS);
    expect(parseSyncFlags({ symbol: true, crosshair: 'no' })).toEqual({
      ...DEFAULT_SYNC_FLAGS,
      symbol: true,
    });
  });
});

describe('replaceTemplate', () => {
  let n = 0;
  const newId = () => `new-${++n}`;

  it('fills leaves with existing charts in order and creates the rest', () => {
    n = 0;
    const old = split('row', [leaf('a'), leaf('b')]);
    const r = replaceTemplate(old, template('2x2')!, ['a', 'b'], newId);
    expect(leaves(r.grid)).toEqual(['a', 'b', 'new-1', 'new-2']);
    expect(r.created).toEqual(['new-1', 'new-2']);
    expect(r.removed).toEqual([]);
    checkInvariants(r.grid);
  });

  it('reports charts without a leaf as removed', () => {
    n = 0;
    const old = template(4)!;
    const ids = ['a', 'b', 'c', 'd'];
    const filled = replaceTemplate(leaf('a'), old, ids, newId).grid;
    const r = replaceTemplate(filled, template('2c')!, ['c', 'a'], newId);
    expect(leaves(r.grid)).toEqual(['c', 'a']);
    expect(r.removed).toEqual(['b', 'd']);
    expect(r.created).toEqual([]);
  });

  it('does not mutate the template', () => {
    const t = template('3c')!;
    const before = structuredClone(t);
    replaceTemplate(leaf('a'), t, ['a'], newId);
    expect(t).toEqual(before);
  });
});
