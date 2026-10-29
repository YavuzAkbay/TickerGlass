export type ChartErrorKind = 'notFound' | 'rateLimited' | 'unavailable' | 'unsupported' | 'other';

/**
 * "{Feature}: not available from {provider}." for a 501 (`feature` is the API's name for what
 * the provider lacks, e.g. "international symbols"); without a feature a generic sentence.
 */
export function unsupportedText(feature: string | undefined, provider: string): string {
  const what = feature ? feature.charAt(0).toUpperCase() + feature.slice(1) : 'This chart';
  return `${what}: not available from ${provider}.`;
}

/** Seconds to wait when a 429 carries no `Retry-After`. */
export const DEFAULT_RETRY_SECONDS = 5;
/** Upper bound for the automatic retry wait. */
export const MAX_RETRY_SECONDS = 60;

/** What went wrong with a chart load: 404 symbol, 429 rate limit, 501 not offered, network/502/503, or anything else. */
export function classifyChartError(
  err: { status?: number | undefined } | null | undefined,
): ChartErrorKind {
  const status = err?.status;
  if (status === 404) return 'notFound';
  if (status === 429) return 'rateLimited';
  if (status === 501) return 'unsupported';
  if (status === 0 || status === 502 || status === 503) return 'unavailable';
  return 'other';
}

/** Whole seconds to count down before the automatic retry. */
export function retryDelaySeconds(retryAfter: number | undefined): number {
  if (retryAfter === undefined || !Number.isFinite(retryAfter)) return DEFAULT_RETRY_SECONDS;
  return Math.min(MAX_RETRY_SECONDS, Math.max(1, Math.ceil(retryAfter)));
}

/** Upper bound for the backed-off wait, before jitter. */
export const MAX_BACKOFF_SECONDS = 120;
/** Automatic retries per session before only the manual Retry button remains. */
export const MAX_AUTO_RETRIES = 5;
/** Jitter added on top of the backed-off wait, as a fraction of it. */
export const RETRY_JITTER = 0.2;

/**
 * Whole seconds to wait before automatic retry number `attempt` (1-based):
 * the server's wait doubled per earlier attempt, capped, plus 0 to 20% random
 * jitter so charts of one grid do not reload in lockstep. `null` once the
 * attempts are used up. `random` is injectable for tests (returns [0, 1)).
 */
export function autoRetryDelaySeconds(
  retryAfter: number | undefined,
  attempt: number,
  random: () => number = Math.random,
): number | null {
  if (attempt > MAX_AUTO_RETRIES) return null;
  const base = retryDelaySeconds(retryAfter);
  const backed = Math.min(MAX_BACKOFF_SECONDS, base * 2 ** Math.max(0, attempt - 1));
  return Math.ceil(backed * (1 + RETRY_JITTER * random()));
}
