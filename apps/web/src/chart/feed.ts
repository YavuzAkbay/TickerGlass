import { HttpDataFeed, ResamplingFeed, SyntheticFeed, type DataFeed } from '@investopen/engine';

/** Native intervals from the API; others resampled client-side.
 * `?feed=synthetic` switches to an offline random-walk feed (dev, e2e, benchmarks). */
function makeFeed(): DataFeed {
  if (new URLSearchParams(location.search).get('feed') === 'synthetic') return new SyntheticFeed();
  return new ResamplingFeed(new HttpDataFeed());
}

export const feed = makeFeed();
