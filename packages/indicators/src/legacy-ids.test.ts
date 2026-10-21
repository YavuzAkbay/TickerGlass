import { describe, expect, it } from 'vitest';
import { defaultRegistry } from './registry';
import './builtins';
import { LEGACY_INDICATOR_IDS, resolveIndicatorId } from './legacy-ids';

describe('legacy indicator ids', () => {
  it('maps every old id to a registered built-in', () => {
    for (const [old, next] of Object.entries(LEGACY_INDICATOR_IDS)) {
      expect(defaultRegistry.get(old)).toBeUndefined();
      expect(defaultRegistry.get(next)).toBeDefined();
    }
  });

  it('resolves renamed ids and leaves others alone', () => {
    expect(resolveIndicatorId('pivots-hl')).toBe('swing-hl');
    expect(resolveIndicatorId('auto-fib')).toBe('swing-fib');
    expect(resolveIndicatorId('relative-volume')).toBe('tod-relative-volume');
    expect(resolveIndicatorId('sma')).toBe('sma');
    expect(resolveIndicatorId('user-abc')).toBe('user-abc');
    expect(resolveIndicatorId('toString')).toBe('toString');
  });
});
