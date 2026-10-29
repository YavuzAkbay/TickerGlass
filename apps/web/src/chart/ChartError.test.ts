import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_SECONDS,
  MAX_AUTO_RETRIES,
  MAX_BACKOFF_SECONDS,
  autoRetryDelaySeconds,
  MAX_RETRY_SECONDS,
  classifyChartError,
  retryDelaySeconds,
  unsupportedText,
} from './errorState';

describe('classifyChartError', () => {
  it.each([
    [404, 'notFound'],
    [429, 'rateLimited'],
    [0, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [501, 'unsupported'],
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

describe('autoRetryDelaySeconds', () => {
  it('doubles per attempt without jitter at random 0', () => {
    expect([1, 2, 3].map((n) => autoRetryDelaySeconds(5, n, () => 0))).toEqual([5, 10, 20]);
  });
  it('caps the backoff', () => {
    expect(autoRetryDelaySeconds(60, 3, () => 0)).toBe(MAX_BACKOFF_SECONDS);
  });
  it('adds up to 20% jitter', () => {
    expect(autoRetryDelaySeconds(10, 1, () => 0.999)).toBe(12);
    expect(autoRetryDelaySeconds(10, 1, () => 0.5)).toBe(11);
  });
  it('gives up after the maximum number of automatic attempts', () => {
    expect(autoRetryDelaySeconds(5, MAX_AUTO_RETRIES, () => 0)).not.toBeNull();
    expect(autoRetryDelaySeconds(5, MAX_AUTO_RETRIES + 1, () => 0)).toBeNull();
  });
});

describe('unsupportedText', () => {
  it('names the feature and the provider', () => {
    expect(unsupportedText('international symbols', 'Twelve Data')).toBe(
      'International symbols: not available from Twelve Data.',
    );
  });

  it('falls back to a generic subject without a feature', () => {
    expect(unsupportedText(undefined, 'this data provider')).toBe(
      'This chart: not available from this data provider.',
    );
  });
});
