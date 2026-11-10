import { describe, expect, it } from 'vitest';
import { expireSticky, initSticky, stickyStep } from './useStickyRows';

const key = (r: { id: string }) => r.id;
const row = (id: string) => ({ id });
const [a, b, c] = [row('a'), row('b'), row('c')];
const ids = (rows: { id: string }[]) => rows.map(key);

describe('stickyStep', () => {
  it('keeps a row that stopped matching until it is expired', () => {
    const s0 = initSticky([a, b], key, 'k', false);
    const s1 = stickyStep(s0, [a], key, 'k', false); // b stopped matching
    expect(ids(s1.out)).toEqual(['a', 'b']);
    expect(ids([...s1.held.values()])).toEqual(['b']);
    // Still held on the next tick…
    const s2 = stickyStep(s1, [a], key, 'k', false);
    expect(ids(s2.out)).toEqual(['a', 'b']);
    // …and dropped once the timer fires.
    expect(ids(expireSticky(s2, key).out)).toEqual(['a']);
  });

  it('a held row that matches again is no longer held', () => {
    const s1 = stickyStep(initSticky([a, b], key, 'k', false), [a], key, 'k', false);
    const s2 = stickyStep(s1, [a, b], key, 'k', false);
    expect(s2.held.size).toBe(0);
    expect(ids(s2.out)).toEqual(['a', 'b']);
  });

  it('new matches appear immediately while live', () => {
    const s1 = stickyStep(initSticky([a], key, 'k', false), [a, c], key, 'k', false);
    expect(ids(s1.out)).toEqual(['a', 'c']);
  });

  it('new matches are deferred while frozen, and appear after', () => {
    const s0 = initSticky([a], key, 'k', true);
    const s1 = stickyStep(s0, [a, c], key, 'k', true);
    expect(ids(s1.out)).toEqual(['a']);
    const s2 = stickyStep(s1, [a, c], key, 'k', false);
    expect(ids(s2.out)).toEqual(['a', 'c']);
  });

  it('a resetKey change (user edited filters) applies at once, nothing held', () => {
    const s0 = initSticky([a, b], key, 'k1', false);
    const s1 = stickyStep(s0, [c], key, 'k2', false);
    expect(ids(s1.out)).toEqual(['c']);
    expect(s1.held.size).toBe(0);
  });

  it('expiring with nothing held keeps the same state object', () => {
    const s0 = initSticky([a], key, 'k', false);
    expect(expireSticky(s0, key)).toBe(s0);
  });
});
