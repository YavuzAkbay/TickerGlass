import { describe, expect, it } from 'vitest';
import { layoutGroups, neighbor, squarify, type Placed, type Rect } from './layout';

const BOX: Rect = { x: 10, y: 20, w: 600, h: 400 };
const area = (r: Rect) => r.w * r.h;
const EPS = 1e-6;

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > EPS && h > EPS ? w * h : 0;
}

function expectInside(placed: Placed[], box: Rect) {
  for (const p of placed) {
    expect(p.x).toBeGreaterThanOrEqual(box.x - EPS);
    expect(p.y).toBeGreaterThanOrEqual(box.y - EPS);
    expect(p.x + p.w).toBeLessThanOrEqual(box.x + box.w + EPS);
    expect(p.y + p.h).toBeLessThanOrEqual(box.y + box.h + EPS);
  }
  for (let i = 0; i < placed.length; i++)
    for (let j = i + 1; j < placed.length; j++) expect(overlap(placed[i]!, placed[j]!)).toBe(0);
}

function expectTiling(placed: Placed[], box: Rect) {
  expectInside(placed, box);
  expect(placed.reduce((s, p) => s + area(p), 0)).toBeCloseTo(area(box), 4);
}

const items = (values: number[]) => values.map((value, i) => ({ id: `s${i}`, value }));

describe('squarify', () => {
  it('gives every item an area proportional to its value', () => {
    const values = [50, 30, 12, 8, 5, 3, 1.5, 1];
    const total = values.reduce((a, b) => a + b, 0);
    const placed = squarify(items(values), BOX);
    expect(placed).toHaveLength(values.length);
    for (const p of placed) {
      expect(area(p) / area(BOX)).toBeCloseTo(p.value / total, 6);
    }
  });

  it('tiles the box: no overlap, inside, areas sum to the box', () => {
    const values = Array.from({ length: 120 }, (_, i) => 1 + ((i * 37) % 91));
    expectTiling(squarify(items(values), BOX), BOX);
  });

  it('works on tall, wide and tiny boxes', () => {
    const values = [9, 7, 5, 3, 2, 2, 1];
    for (const box of [
      { x: 0, y: 0, w: 50, h: 900 },
      { x: 0, y: 0, w: 900, h: 50 },
      { x: 5, y: 5, w: 3, h: 3 },
    ])
      expectTiling(squarify(items(values), box), box);
  });

  it('orders the result by descending value (ties keep input order)', () => {
    const placed = squarify(items([2, 9, 2, 5]), BOX);
    expect(placed.map((p) => p.id)).toEqual(['s1', 's3', 's0', 's2']);
  });

  it('keeps aspect ratios reasonable for a typical market-cap spread', () => {
    const values = [3000, 2800, 1500, 900, 600, 400, 300, 250, 200, 150, 120, 100, 80, 60, 50];
    const placed = squarify(items(values), { x: 0, y: 0, w: 1000, h: 600 });
    for (const p of placed) expect(Math.max(p.w / p.h, p.h / p.w)).toBeLessThan(6);
  });

  it('one item fills the box; nothing usable gives nothing', () => {
    expect(squarify(items([4]), BOX)).toEqual([{ id: 's0', value: 4, ...BOX }]);
    expect(squarify([], BOX)).toEqual([]);
    expect(squarify(items([0, -1, NaN]), BOX)).toEqual([]);
    expect(squarify(items([1]), { x: 0, y: 0, w: 0, h: 10 })).toEqual([]);
  });

  it('drops unusable values and still tiles the rest', () => {
    const placed = squarify(items([5, 0, 3, -2, Infinity, 2]), BOX);
    expect(placed.map((p) => p.id).sort()).toEqual(['s0', 's2', 's5']);
    expectTiling(placed, BOX);
  });
});

describe('layoutGroups', () => {
  const groups = [
    {
      id: 'Tech',
      items: [
        { id: 'A', value: 40 },
        { id: 'B', value: 20 },
        { id: 'C', value: 10 },
      ],
    },
    {
      id: 'Energy',
      items: [
        { id: 'D', value: 15 },
        { id: 'E', value: 5 },
      ],
    },
    { id: 'Health', items: [{ id: 'F', value: 10 }] },
  ];

  it('sizes group boxes by their totals and keeps tiles inside their box', () => {
    const out = layoutGroups(groups, BOX);
    const total = 100;
    expect(out.groups).toHaveLength(3);
    for (const g of out.groups) {
      const sum = groups.find((x) => x.id === g.id)!.items.reduce((s, i) => s + i.value, 0);
      expect(area(g.rect) / area(BOX)).toBeCloseTo(sum / total, 6);
    }
    expectTiling(
      out.groups.map((g) => ({ id: g.id, value: g.value, ...g.rect })),
      BOX,
    );
    for (const t of out.tiles) {
      const g = out.groups.find((x) => x.id === t.group)!;
      expect(t.x).toBeGreaterThanOrEqual(g.rect.x - EPS);
      expect(t.y).toBeGreaterThanOrEqual(g.rect.y - EPS);
      expect(t.x + t.w).toBeLessThanOrEqual(g.rect.x + g.rect.w + EPS);
      expect(t.y + t.h).toBeLessThanOrEqual(g.rect.y + g.rect.h + EPS);
    }
    expect(out.tiles).toHaveLength(6);
    // Headers and padding take space, so the tiles cover less than the box, without overlap.
    expectInside(out.tiles, BOX);
    // Inside one group, tile areas stay proportional to their values.
    const tech = out.tiles.filter((t) => t.group === 'Tech');
    for (const t of tech)
      expect(area(t) / tech.reduce((s, x) => s + area(x), 0)).toBeCloseTo(t.value / 70, 6);
  });

  it('reserves a header strip above the tiles of a group that is big enough', () => {
    const out = layoutGroups(groups, BOX);
    const tech = out.groups.find((g) => g.id === 'Tech')!;
    expect(tech.header).not.toBeNull();
    for (const t of out.tiles.filter((x) => x.group === 'Tech'))
      expect(t.y).toBeGreaterThanOrEqual(tech.header!.y + tech.header!.h - EPS);
  });

  it('drops the header of a group too small to label', () => {
    const out = layoutGroups(
      [
        { id: 'Big', items: [{ id: 'A', value: 1000 }] },
        { id: 'Tiny', items: [{ id: 'B', value: 1 }] },
      ],
      { x: 0, y: 0, w: 300, h: 200 },
    );
    expect(out.groups.find((g) => g.id === 'Tiny')!.header).toBeNull();
    expect(out.tiles).toHaveLength(2);
  });

  it('lays a single group (or flat mode) out without headers', () => {
    const one = layoutGroups([groups[0]!], BOX);
    expect(one.groups[0]!.header).toBeNull();
    expectTiling(one.tiles, BOX);
    const flat = layoutGroups(groups, BOX, undefined, true);
    expect(flat.groups.every((g) => g.header === null)).toBe(true);
    expect(flat.tiles).toHaveLength(6);
    expectTiling(flat.tiles, BOX);
  });

  it('skips empty groups', () => {
    const out = layoutGroups([{ id: 'Empty', items: [] }, groups[1]!], BOX);
    expect(out.groups.map((g) => g.id)).toEqual(['Energy']);
  });
});

describe('neighbor (arrow keys)', () => {
  // 2 x 2 grid:  a b / c d
  const grid = [
    { id: 'a', x: 0, y: 0, w: 100, h: 100 },
    { id: 'b', x: 100, y: 0, w: 100, h: 100 },
    { id: 'c', x: 0, y: 100, w: 100, h: 100 },
    { id: 'd', x: 100, y: 100, w: 100, h: 100 },
  ];

  it('moves to the adjacent tile in the arrow direction', () => {
    expect(neighbor(grid, 'a', 'right')).toBe('b');
    expect(neighbor(grid, 'a', 'down')).toBe('c');
    expect(neighbor(grid, 'd', 'left')).toBe('c');
    expect(neighbor(grid, 'd', 'up')).toBe('b');
  });

  it('stays put at an edge or for an unknown tile', () => {
    expect(neighbor(grid, 'a', 'left')).toBeNull();
    expect(neighbor(grid, 'a', 'up')).toBeNull();
    expect(neighbor(grid, 'zzz', 'up')).toBeNull();
  });

  it('prefers the tile in line over a nearer diagonal one', () => {
    const tiles = [
      { id: 'from', x: 0, y: 0, w: 100, h: 100 },
      { id: 'diag', x: 100, y: 150, w: 20, h: 20 },
      { id: 'inline', x: 160, y: 40, w: 20, h: 20 },
    ];
    expect(neighbor(tiles, 'from', 'right')).toBe('inline');
  });

  it('reaches every tile of a real layout by arrows', () => {
    const placed = squarify(items([40, 25, 15, 10, 6, 4]), BOX);
    const seen = new Set<string>([placed[0]!.id]);
    const queue = [placed[0]!.id];
    while (queue.length) {
      const cur = queue.pop()!;
      for (const dir of ['left', 'right', 'up', 'down'] as const) {
        const n = neighbor(placed, cur, dir);
        if (n && !seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect(seen.size).toBe(placed.length);
  });
});
