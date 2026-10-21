import { describe, expect, it } from 'vitest';
import { cycleFocus } from './focus';

describe('cycleFocus', () => {
  const order = ['a', 'b', 'c'];
  it('steps and wraps in both directions', () => {
    expect(cycleFocus(order, 'a', 1)).toBe('b');
    expect(cycleFocus(order, 'c', 1)).toBe('a');
    expect(cycleFocus(order, 'a', -1)).toBe('c');
    expect(cycleFocus(order, 'b', -1)).toBe('a');
  });
  it('starts at an end when nothing valid is focused', () => {
    expect(cycleFocus(order, null, 1)).toBe('a');
    expect(cycleFocus(order, 'zz', -1)).toBe('c');
  });
  it('has no target without charts', () => {
    expect(cycleFocus([], 'a', 1)).toBeNull();
    expect(cycleFocus(['a'], 'a', 1)).toBe('a');
  });
});
