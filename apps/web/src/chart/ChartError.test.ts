import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_SECONDS,
  MAX_RETRY_SECONDS,
  classifyChartError,
  retryDelaySeconds,
} from './errorState';

describe('classifyChartError', () => {
  it.each([
    [404, 'notFound'],
    [429, 'rateLimited'],
    [0, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [500, 'other'],
    [400, 'other'],
  ] as const)('status %i is %s', (status, kind) => {
    expect(classifyChartError({ status })).toBe(kind);
  });

  it('treats a missing status as other', () => {
    expect(classifyChartError({})).toBe('other');
    expect(classifyChartError(null)).toBe('other');
  });
});

describe('retryDelaySeconds', () => {
  it('uses the default without Retry-After', () => {
    expect(retryDelaySeconds(undefined)).toBe(DEFAULT_RETRY_SECONDS);
    expect(retryDelaySeconds(NaN)).toBe(DEFAULT_RETRY_SECONDS);
  });
  it('rounds up and clamps', () => {
    expect(retryDelaySeconds(1)).toBe(1);
    expect(retryDelaySeconds(1.2)).toBe(2);
    expect(retryDelaySeconds(0)).toBe(1);
    expect(retryDelaySeconds(9999)).toBe(MAX_RETRY_SECONDS);
  });
});
