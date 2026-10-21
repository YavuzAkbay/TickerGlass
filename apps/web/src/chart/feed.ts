import {
  CoalescingFeed,
  ExpressionFeed,
  HttpDataFeed,
  ReplayFeed,
  ResamplingFeed,
  SyntheticFeed,
  type DataFeed,
} from '@tickerglass/engine';
import { apiLookbackSeconds } from '../replay/limits';

const feedMode = () => new URLSearchParams(location.search).get('feed');

/** Native intervals from the API; others resampled client-side; symbol
 * expressions (e.g. `AAPL/MSFT`) evaluated client-side from their legs.
 * `?feed=synthetic` switches to an offline random-walk feed (dev, e2e,
 * benchmarks); `?feed=synthetic-multi` gives every symbol its own series. */
function makeFeed(): DataFeed {
  const mode = feedMode();
  if (mode === 'synthetic') return new ExpressionFeed(new SyntheticFeed());
  if (mode === 'synthetic-multi')
    return new ExpressionFeed(new SyntheticFeed(100_000, undefined, 42, { perSymbol: true }));
  return new ExpressionFeed(new ResamplingFeed(new CoalescingFeed(new HttpDataFeed())));
}

/** Outermost layer: passthrough while live, clipped to the replay clock during replay.
 * Synthetic feeds have no history limits. */
export const replayFeed = new ReplayFeed(makeFeed(), {
  lookbackSeconds: feedMode()?.startsWith('synthetic') ? () => null : apiLookbackSeconds,
});

/** The feed every consumer (chart, compares, indicators) shares. */
export const feed: DataFeed = replayFeed;
