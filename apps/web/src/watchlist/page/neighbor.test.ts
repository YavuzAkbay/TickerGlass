import { describe, expect, it } from 'vitest';
import { neighborAfterRemoval } from './neighbor';

const has =
  (...live: string[]) =>
  (s: string) =>
    live.includes(s);

describe('neighborAfterRemoval', () => {
  it('prefers the next row', () => {
    expect(neighborAfterRemoval(['A', 'B', 'C'], 'B', has('A', 'C'))).toBe('C');
  });
  it('falls back to the previous row at the end', () => {
    expect(neighborAfterRemoval(['A', 'B', 'C'], 'C', has('A', 'B'))).toBe('B');
  });
  it('skips neighbours that were removed too', () => {
    expect(neighborAfterRemoval(['A', 'B', 'C', 'D'], 'B', has('A', 'D'))).toBe('D');
  });
  it('closes when nothing is left or the row was never displayed', () => {
    expect(neighborAfterRemoval(['A'], 'A', has())).toBeNull();
    expect(neighborAfterRemoval(['A', 'B'], 'X', has('A', 'B'))).toBeNull();
  });
});
