import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setNowForTest, NOW_STEP_MS, readNow } from './useNow';

describe('shared clock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('does not serve an hours-old value when nobody was listening', () => {
    __setNowForTest(Date.now() - 3 * 3_600_000);
    expect(readNow()).toBe(Date.now());
  });

  it('is not quantized and is stable within a step', () => {
    __setNowForTest(Date.now());
    const first = readNow();
    vi.advanceTimersByTime(NOW_STEP_MS - 1);
    expect(readNow()).toBe(first);
    vi.advanceTimersByTime(1);
    expect(readNow()).toBe(Date.now());
  });
});
