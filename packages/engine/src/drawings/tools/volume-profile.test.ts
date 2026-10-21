import { beforeEach, describe, expect, it } from 'vitest';
import type { DrawingBarData } from '../types';
import {
  cachedVolumeProfile,
  clearVolumeProfileCache,
  computeVolumeProfile,
  MAX_VP_ROWS,
  profileLevels,
  rowVolume,
  type VolumeProfileOptions,
} from './volume-profile';

type Bar = [open: number, high: number, low: number, close: number, volume: number];

function bars(list: Bar[]): DrawingBarData {
  return {
    length: list.length,
    time: list.map((_, i) => i),
    open: list.map((b) => b[0]),
    high: list.map((b) => b[1]),
    low: list.map((b) => b[2]),
    close: list.map((b) => b[3]),
    volume: list.map((b) => b[4]),
  };
}

const COUNT = (rows: number, valueArea = 70): VolumeProfileOptions => ({
  rowsLayout: 'count',
  rows,
  rowSize: 1,
  valueArea,
});
const SIZE = (rowSize: number, valueArea = 70): VolumeProfileOptions => ({
  rowsLayout: 'size',
  rows: 24,
  rowSize,
  valueArea,
});

const totals = (p: NonNullable<ReturnType<typeof computeVolumeProfile>>) =>
  Array.from({ length: p.rows }, (_, i) => rowVolume(p, i));

beforeEach(() => clearVolumeProfileCache());

describe('computeVolumeProfile', () => {
  it('golden: 4 rows, even spread, up/down split, POC and value area', () => {
    // Range 0..4, 4 rows of 1.
    // A up   [0,4] vol 40 -> 10 in each row.
    // B down [2,3] vol 30 -> row 2 (row 3 only touches at 3: zero overlap).
    // C up   [1,2] vol 20 -> row 1.
    // up [10,30,10,10], down [0,0,30,0], totals [10,30,40,10] = 90.
    // POC row 2 (40). Target 70% = 63: above pair = row 3 only (10), below
    // pair = rows 1+0 (40) -> add below: 80 >= 63. VA rows 0..2.
    const b = bars([
      [1, 4, 0, 3, 40],
      [2.5, 3, 2, 2.2, 30],
      [1, 2, 1, 1.5, 20],
    ]);
    const p = computeVolumeProfile(b, 0, 2, COUNT(4))!;
    expect([p.start, p.rowSize, p.rows, p.low, p.high]).toEqual([0, 1, 4, 0, 4]);
    expect(Array.from(p.up)).toEqual([10, 30, 10, 10]);
    expect(Array.from(p.down)).toEqual([0, 0, 30, 0]);
    expect(p.totalVolume).toBe(90);
    expect(p.maxRow).toBe(40);
    expect([p.poc, p.val, p.vah]).toEqual([2, 0, 2]);
    // POC = middle of row 2, VAH = top of row 2, VAL = bottom of row 0.
    expect(profileLevels(p)).toEqual({ poc: 2.5, vah: 3, val: 0 });
  });

  it('golden: value area adds two rows at a time, ties go above', () => {
    // 6 rows over 0..6. Spanning bar [0,6] vol 6 -> 1 per row; flat bars add
    // 2 @ row 0, 4 @ row 1, 9 @ row 2, 3 @ row 3, 3 @ row 4.
    // Totals [3,5,10,4,4,1] = 27, POC row 2.
    // 60%: target 16.2; above pair rows 3+4 = 8, below pair rows 1+0 = 8,
    //   tie -> above: 18 >= 16.2 -> VA rows 2..4.
    // 70%: target 18.9; after the tie step 18 < 18.9; above = row 5 only (1),
    //   below pair = 8 -> below: 26 -> VA rows 0..4.
    const list: Bar[] = [
      [0, 6, 0, 6, 6],
      [0.5, 0.5, 0.5, 0.5, 2],
      [1.5, 1.5, 1.5, 1.5, 4],
      [2.6, 2.5, 2.5, 2.5, 9],
      [3.5, 3.5, 3.5, 3.5, 3],
      [4.5, 4.5, 4.5, 4.5, 3],
    ];
    const p60 = computeVolumeProfile(bars(list), 0, 5, COUNT(6, 60))!;
    expect(totals(p60)).toEqual([3, 5, 10, 4, 4, 1]);
    // Flat bar at 2.5 closes below its open: down volume.
    expect(p60.down[2]).toBe(9);
    expect([p60.poc, p60.val, p60.vah]).toEqual([2, 2, 4]);
    const p70 = computeVolumeProfile(bars(list), 0, 5, COUNT(6, 70))!;
    expect([p70.poc, p70.val, p70.vah]).toEqual([2, 0, 4]);
    expect(profileLevels(p70)).toEqual({ poc: 2.5, vah: 5, val: 0 });
  });

  it('golden: row size layout aligns rows and splits partial overlaps', () => {
    // Bar [0.5,1.5] vol 10, row size 1: start floor(0.5) = 0, rows ceil(1.5) = 2.
    // Overlap 0.5 with each row -> 5 + 5. POC tie: both rows 0.5 from the
    // middle (0.5) -> lower row 0. VA: 5 < 7, add row 1 -> rows 0..1.
    const p = computeVolumeProfile(bars([[0.5, 1.5, 0.5, 1, 10]]), 0, 0, SIZE(1))!;
    expect([p.start, p.rows, p.rowSize]).toEqual([0, 2, 1]);
    expect(Array.from(p.up)).toEqual([5, 5]);
    expect([p.poc, p.val, p.vah]).toEqual([0, 0, 1]);
    expect(profileLevels(p)).toEqual({ poc: 0.5, vah: 2, val: 0 });

    // Bar [0.3,1.3] vol 10, row size 0.5: start 0, rows ceil(2.6) = 3.
    // Overlaps 0.2, 0.5, 0.3 of a 1.0 range -> 2, 5, 3.
    const q = computeVolumeProfile(bars([[1, 1.3, 0.3, 0.5, 10]]), 0, 0, SIZE(0.5))!;
    expect([q.start, q.rows]).toEqual([0, 3]);
    expect(q.down[0]).toBeCloseTo(2, 9);
    expect(q.down[1]).toBeCloseTo(5, 9);
    expect(q.down[2]).toBeCloseTo(3, 9);
    expect(q.poc).toBe(1);
  });

  it('clamps and orders the range, skips bars without volume', () => {
    const b = bars([
      [1, 4, 0, 3, 40],
      [50, 99, 50, 60, 0],
      [1, 2, 1, 1.5, NaN],
    ]);
    const p = computeVolumeProfile(b, 10, -5, COUNT(4))!;
    expect([p.from, p.to]).toEqual([0, 2]);
    // Bars 1 and 2 have no volume: they do not widen the range.
    expect([p.low, p.high, p.totalVolume]).toEqual([0, 4, 40]);
    expect(computeVolumeProfile(b, 1, 2, COUNT(4))).toBeNull();
    expect(computeVolumeProfile(b, 5, 9, COUNT(4))).toBeNull();
    expect(computeVolumeProfile(b, NaN, 1, COUNT(4))).toBeNull();
  });

  it('puts flat ranges in one row and caps the row count', () => {
    const flat = computeVolumeProfile(
      bars([
        [5, 5, 5, 5, 3],
        [5, 5, 5, 5, 4],
      ]),
      0,
      1,
      COUNT(24),
    )!;
    expect([flat.rows, flat.rowSize, flat.up[0], flat.poc, flat.val, flat.vah]).toEqual([
      1, 0, 7, 0, 0, 0,
    ]);
    const tiny = computeVolumeProfile(bars([[0, 10, 0, 10, 1]]), 0, 0, SIZE(0.0001))!;
    expect(tiny.rows).toBe(MAX_VP_ROWS);
    expect(tiny.rowSize).toBeCloseTo(10 / MAX_VP_ROWS, 12);
    expect(computeVolumeProfile(bars([[0, 10, 0, 10, 1]]), 0, 0, COUNT(5000))!.rows).toBe(
      MAX_VP_ROWS,
    );
  });
});

describe('cachedVolumeProfile', () => {
  it('reuses the profile until the data, range, options or last bar change', () => {
    const b = bars([
      [1, 4, 0, 3, 40],
      [1, 2, 1, 1.5, 20],
    ]);
    const a = cachedVolumeProfile('d', b, 0, 1, COUNT(4));
    expect(cachedVolumeProfile('d', b, 1, 0, COUNT(4))).toBe(a);
    expect(cachedVolumeProfile('d', b, 0, 1, COUNT(8))).not.toBe(a);
    const c = cachedVolumeProfile('d', b, 0, 1, COUNT(4));
    // Realtime tick: the last bar changes in place.
    (b.volume as number[])[1] = 30;
    const d = cachedVolumeProfile('d', b, 0, 1, COUNT(4))!;
    expect(d).not.toBe(c);
    expect(d.totalVolume).toBe(70);
    // A reload replaces the arrays.
    expect(cachedVolumeProfile('d', { ...b, volume: [40, 30] }, 0, 1, COUNT(4))).not.toBe(d);
  });
});
