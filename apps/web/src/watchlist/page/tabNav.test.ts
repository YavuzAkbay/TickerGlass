import { describe, expect, it } from 'vitest';
import { tabKeyTarget } from './tabNav';

describe('tabKeyTarget', () => {
  it('moves right/left and wraps', () => {
    expect(tabKeyTarget(0, 3, 'ArrowRight')).toBe(1);
    expect(tabKeyTarget(2, 3, 'ArrowRight')).toBe(0);
    expect(tabKeyTarget(1, 3, 'ArrowLeft')).toBe(0);
    expect(tabKeyTarget(0, 3, 'ArrowLeft')).toBe(2);
  });
  it('jumps to the ends', () => {
    expect(tabKeyTarget(1, 4, 'Home')).toBe(0);
    expect(tabKeyTarget(1, 4, 'End')).toBe(3);
  });
  it('starts at the edge when no tab is focused', () => {
    expect(tabKeyTarget(-1, 3, 'ArrowRight')).toBe(0);
    expect(tabKeyTarget(-1, 3, 'ArrowLeft')).toBe(2);
  });
  it('ignores other keys and empty lists', () => {
    expect(tabKeyTarget(0, 3, 'Enter')).toBeNull();
    expect(tabKeyTarget(0, 0, 'ArrowRight')).toBeNull();
  });
});
