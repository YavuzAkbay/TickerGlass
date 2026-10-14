import {
  ExpressionFeed,
  HttpDataFeed,
  ResamplingFeed,
  SyntheticFeed,
  type DataFeed,
} from '@investopen/engine';

/** Native intervals from the API; others resampled client-side; symbol
 * expressions (e.g. `AAPL/MSFT`) evaluated client-side from their legs.
 * `?feed=synthetic` switches to an offline random-walk feed (dev, e2e,
 * benchmarks); `?feed=synthetic-multi` gives every symbol its own series. */
function makeFeed(): DataFeed {
  const mode = new URLSearchParams(location.search).get('feed');
  if (mode === 'synthetic') return new ExpressionFeed(new SyntheticFeed());
  if (mode === 'synthetic-multi')
    return new ExpressionFeed(new SyntheticFeed(100_000, undefined, 42, { perSymbol: true }));
  return new ExpressionFeed(new ResamplingFeed(new HttpDataFeed()));
}

export const feed = makeFeed();
