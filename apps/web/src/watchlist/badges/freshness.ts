/** How current a quote is, for the row badges. Pure: `now` is injected. */
import type { LiveQuote } from '../../quotes/types';

export type Freshness =
  'live' | 'delayed' | 'stale' | 'closed' | 'pre' | 'post' | 'missing' | 'unknown';

/** A tick this recent on a live stream counts as live. */
export const LIVE_MAX_AGE_MS = 60_000;
/** Polled / snapshot data this recent is "delayed", older is "stale". */
export const DELAYED_MAX_AGE_MS = 120_000;

/** Crypto and similar 24/7 pairs never close (provider states are ignored for them). */
const ALWAYS_OPEN = /^[A-Z0-9.]+-(USD|USDT|USDC|EUR|GBP|JPY|BTC|ETH)$/;

export function quoteFreshness(
  q: LiveQuote | undefined,
  now: number,
  opts: {
    streamStatus: string;
    missing: boolean;
    /**
     * When the quote last received data from a snapshot (ms). Snapshots carry no data
     * time of their own (`Quote.time` is a daily-bar stamp), so callers pass when they
     * observed the update. Age is measured from the newest of this and `lastTickMs`.
     */
    updatedMs?: number | null | undefined;
  },
): Freshness {
  if (opts.missing) return 'missing';
  if (!q) return 'unknown';
  if (!ALWAYS_OPEN.test(q.symbol.toUpperCase())) {
    switch (q.marketState?.toUpperCase()) {
      case 'CLOSED':
      case 'POSTPOST':
      case 'PREPRE':
        return 'closed';
      case 'PRE':
        return 'pre';
      case 'POST':
        return 'post';
    }
  }
  if (q.last === null) return 'unknown';
  const tickMs = q.lastTickMs;
  if (tickMs !== null && now - tickMs < LIVE_MAX_AGE_MS && opts.streamStatus === 'live') {
    return 'live';
  }
  // Newest data of any source; with no time at all the quote is polled data of unknown age.
  const dataMs = Math.max(tickMs ?? -Infinity, opts.updatedMs ?? -Infinity);
  if (dataMs === -Infinity) return 'delayed';
  return Math.max(0, now - dataMs) < DELAYED_MAX_AGE_MS ? 'delayed' : 'stale';
}
