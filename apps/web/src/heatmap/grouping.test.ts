import { describe, expect, it } from 'vitest';
import { aggregate, groupEntries, groupRows, mean, weightedMean } from './grouping';

describe('mean / weightedMean', () => {
  it('ignore missing values and give null for nothing', () => {
    expect(mean([1, 2, null, undefined, NaN, 6])).toBe(3);
    expect(mean([])).toBeNull();
    expect(mean([null])).toBeNull();
  });

  it('weight by size and skip entries without a value or a positive weight', () => {
    expect(weightedMean([10, 0], [1, 3])).toBeCloseTo(2.5);
    expect(weightedMean([10, null, 4], [1, 5, 0])).toBe(10);
    expect(weightedMean([1], [null])).toBeNull();
    expect(weightedMean([], [])).toBeNull();
  });
});

describe('groupRows', () => {
  const rows = [
    { s: 'A', g: 'Tech' },
    { s: 'B', g: 'Energy' },
    { s: 'C', g: 'Tech' },
    { s: 'D', g: '' },
    { s: 'E', g: 'Energy' },
  ];

  it('groups in order of the first row and keeps the order inside a group', () => {
    const out = groupRows(rows, (r) => r.g);
    expect(out.map((g) => g.key)).toEqual(['Tech', 'Energy', '']);
    expect(out[0]!.rows.map((r) => r.s)).toEqual(['A', 'C']);
    expect(out[1]!.rows.map((r) => r.s)).toEqual(['B', 'E']);
  });

  it('keeps a sorted list sorted within each group', () => {
    const sorted = [
      { s: 'X', g: 'a', v: 9 },
      { s: 'Y', g: 'b', v: 8 },
      { s: 'Z', g: 'a', v: 1 },
    ];
    const out = groupRows(sorted, (r) => r.g);
    expect(out[0]!.rows.map((r) => r.v)).toEqual([9, 1]);
  });

  it('is empty for no rows', () => {
    expect(groupRows([], () => 'x')).toEqual([]);
  });
});

describe('aggregate', () => {
  it('counts, averages the change and sums the known caps', () => {
    const agg = aggregate([
      { change: 2, cap: 1e12 },
      { change: -1, cap: 5e11 },
      { change: null, cap: null },
    ]);
    expect(agg.count).toBe(3);
    expect(agg.avgChange).toBeCloseTo(0.5);
    expect(agg.totalCap).toBe(1.5e12);
  });

  it('reports unknowns as null', () => {
    expect(aggregate([{ change: null, cap: null }])).toEqual({
      count: 1,
      avgChange: null,
      totalCap: null,
    });
    expect(aggregate([]).count).toBe(0);
  });
});

describe('groupEntries', () => {
  const groups = groupRows(
    [
      { s: 'A', g: 'Tech' },
      { s: 'B', g: 'Tech' },
      { s: 'C', g: 'Energy' },
    ],
    (r) => r.g,
  );
  const agg = (rows: readonly unknown[]) => ({
    count: rows.length,
    avgChange: null,
    totalCap: null,
  });

  it('puts a header before each group and lists the rows below it', () => {
    const out = groupEntries(groups, new Set(), agg);
    expect(out.map((e) => (e.kind === 'group' ? `#${e.key}:${e.agg.count}` : e.row.s))).toEqual([
      '#Tech:2',
      'A',
      'B',
      '#Energy:1',
      'C',
    ]);
  });

  it('hides the rows of collapsed groups but keeps the header and its aggregate', () => {
    const out = groupEntries(groups, new Set(['Tech']), agg);
    expect(out.map((e) => (e.kind === 'group' ? `#${e.key}:${e.collapsed}` : e.row.s))).toEqual([
      '#Tech:true',
      '#Energy:false',
      'C',
    ]);
    expect(out[0]).toMatchObject({ kind: 'group', agg: { count: 2 } });
  });
});
