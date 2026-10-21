export type ChartErrorKind = 'notFound' | 'rateLimited' | 'unavailable' | 'other';

/** Seconds to wait when a 429 carries no `Retry-After`. */
export const DEFAULT_RETRY_SECONDS = 5;
/** Upper bound for the automatic retry wait. */
export const MAX_RETRY_SECONDS = 60;

/** What went wrong with a chart load: 404 symbol, 429 rate limit, network/502/503, or anything else. */
export function classifyChartError(
  err: { status?: number | undefined } | null | undefined,
): ChartErrorKind {
  const status = err?.status;
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status === 0 || status === 502 || status === 503) return 'unavailable';
  return 'other';
}

/** Whole seconds to count down before the automatic retry. */
export function retryDelaySeconds(retryAfter: number | undefined): number {
  if (retryAfter === undefined || !Number.isFinite(retryAfter)) return DEFAULT_RETRY_SECONDS;
  return Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(retryAfter)));
}
