import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StableOrder, applyOrder, useStableOrder } from './useStableOrder';

type Row = { id: string; v?: number };
const key = (r: Row) => r.id;
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const ids = (list: Row[]) => list.map(key).join('');

describe('applyOrder', () => {
  it('orders by the committed order, drops removed keys', () => {
    expect(ids(applyOrder(rows('a', 'b', 'c'), key, ['c', 'x', 'a', 'b']))).toBe('cab');
  });
  it('inserts new keys at their fresh index', () => {
    expect(ids(applyOrder(rows('n', 'a', 'b'), key, ['b', 'a']))).toBe('nba');
    expect(ids(applyOrder(rows('a', 'n', 'b'), key, ['b', 'a']))).toBe('bna');
  });
  it('clamps the insert index to the end', () => {
    expect(ids(applyOrder(rows('a', 'b', 'c', 'n'), key, ['c', 'a']))).toBe('cban');
  });
  it('handles an empty order', () => {
    expect(ids(applyOrder(rows('a', 'b'), key, []))).toBe('ab');
  });
});

describe('StableOrder', () => {
  const run = (s: StableOrder<Row>, list: Row[], now: number, frozen = false, interval = 1500) =>
    s.update(list, key, interval, frozen, now);

  it('first call commits immediately', () => {
    const s = new StableOrder<Row>();
    const r = run(s, rows('b', 'a'), 0);
    expect(ids(r.items)).toBe('ba');
    expect(r.pendingInMs).toBeNull();
  });

  it('holds the committed order until the interval has elapsed', () => {
    const s = new StableOrder<Row>();
    run(s, rows('a', 'b', 'c'), 0);
    const r = run(s, rows('c', 'b', 'a'), 500);
    expect(ids(r.items)).toBe('abc');
    expect(r.pendingInMs).toBe(1000);
    expect(ids(run(s, rows('c', 'b', 'a'), 1499).items)).toBe('abc');
    const done = run(s, rows('c', 'b', 'a'), 1500);
    expect(ids(done.items)).toBe('cba');
    expect(done.pendingInMs).toBeNull();
  });

  it('a change after a long quiet period commits at once', () => {
    const s = new StableOrder<Row>();
    run(s, rows('a', 'b'), 0);
    expect(ids(run(s, rows('b', 'a'), 10_000).items)).toBe('ba');
  });

  it('frozen blocks commits and reports nothing pending; unfreezing commits', () => {
    const s = new StableOrder<Row>();
    run(s, rows('a', 'b'), 0);
    const f = run(s, rows('b', 'a'), 5000, true);
    expect(ids(f.items)).toBe('ab');
    expect(f.pendingInMs).toBeNull();
    // Unfrozen right after a commit-free period: commit even if less than the interval passed.
    run(s, rows('b', 'a'), 5100, true);
    expect(ids(run(s, rows('b', 'a'), 5200, false).items)).toBe('ba');
  });

  it('unfreezing commits even inside the interval of a recent commit', () => {
    const s = new StableOrder<Row>();
    run(s, rows('a', 'b'), 0);
    run(s, rows('b', 'a'), 2000); // commit at 2000
    run(s, rows('b', 'a'), 2100, true);
    run(s, rows('a', 'b'), 2200, true);
    expect(ids(run(s, rows('a', 'b'), 2300, false).items)).toBe('ab');
  });

  it('removed keys drop and new keys appear at once while an order is pending', () => {
    const s = new StableOrder<Row>();
    run(s, rows('a', 'b', 'c'), 0);
    const r = run(s, rows('n', 'c', 'a'), 100);
    expect(ids(r.items)).toBe('nac');
    expect(r.pendingInMs).toBe(1400);
  });

  it('returns the same array while order and items are unchanged', () => {
    const s = new StableOrder<Row>();
    const list = rows('a', 'b');
    const first = run(s, list, 0).items;
    expect(run(s, [...list], 100).items).toBe(first);
    // Same keys, new item object: output changes so consumers see the fresh data.
    expect(run(s, rows('a', 'b'), 200).items).not.toBe(first);
  });

  it('keeps showing fresh item data while the order is held', () => {
    const s = new StableOrder<Row>();
    run(
      s,
      [
        { id: 'a', v: 1 },
        { id: 'b', v: 2 },
      ],
      0,
    );
    const r = run(
      s,
      [
        { id: 'b', v: 3 },
        { id: 'a', v: 1 },
      ],
      100,
    );
    expect(r.items).toEqual([
      { id: 'a', v: 1 },
      { id: 'b', v: 3 },
    ]);
  });
});

describe('useStableOrder', () => {
  it('renders the given order on first render', () => {
    function Probe() {
      const list = useStableOrder(rows('b', 'a'), key, { intervalMs: 10 });
      return createElement('span', null, ids(list));
    }
    expect(renderToString(createElement(Probe))).toContain('ba');
  });
});
