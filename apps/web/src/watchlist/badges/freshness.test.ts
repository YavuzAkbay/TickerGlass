import { describe, expect, it } from 'vitest';
import { emptyQuote } from '../../quotes/merge';
import type { LiveQuote } from '../../quotes/types';
import { DELAYED_MAX_AGE_MS, LIVE_MAX_AGE_MS, quoteFreshness } from './freshness';

const NOW = 1_700_000_000_000;
const live = { streamStatus: 'live', missing: false };

const q = (over: Partial<LiveQuote> = {}): LiveQuote => ({
  ...emptyQuote('AAPL'),
  last: 190,
  marketState: 'REGULAR',
  lastTickMs: NOW - 1000,
  ...over,
});

describe('quoteFreshness', () => {
  it('missing wins over everything', () => {
    expect(quoteFreshness(q(), NOW, { ...live, missing: true })).toBe('missing');
    expect(quoteFreshness(undefined, NOW, { ...live, missing: true })).toBe('missing');
  });

  it('is unknown without a quote or a price', () => {
    expect(quoteFreshness(undefined, NOW, live)).toBe('unknown');
    expect(quoteFreshness(q({ last: null }), NOW, live)).toBe('unknown');
  });

  it.each(['CLOSED', 'POSTPOST', 'PREPRE', 'closed'])('%s is closed', (marketState) => {
    expect(quoteFreshness(q({ marketState }), NOW, live)).toBe('closed');
  });

  it('maps PRE and POST', () => {
    expect(quoteFreshness(q({ marketState: 'PRE' }), NOW, live)).toBe('pre');
    expect(quoteFreshness(q({ marketState: 'POST' }), NOW, live)).toBe('post');
  });

  it('session states win over tick age', () => {
    expect(quoteFreshness(q({ marketState: 'CLOSED', lastTickMs: NOW }), NOW, live)).toBe('closed');
  });

  it('regular session with a recent tick on a live stream is live', () => {
    expect(quoteFreshness(q(), NOW, live)).toBe('live');
    expect(quoteFreshness(q({ lastTickMs: NOW - LIVE_MAX_AGE_MS + 1 }), NOW, live)).toBe('live');
  });

  it('treats a missing market state like a regular session', () => {
    expect(quoteFreshness(q({ marketState: null }), NOW, live)).toBe('live');
  });

  it('a tick of 60 s or more is delayed, then stale from 2 min', () => {
    expect(quoteFreshness(q({ lastTickMs: NOW - LIVE_MAX_AGE_MS }), NOW, live)).toBe('delayed');
    expect(quoteFreshness(q({ lastTickMs: NOW - DELAYED_MAX_AGE_MS + 1 }), NOW, live)).toBe(
      'delayed',
    );
    expect(quoteFreshness(q({ lastTickMs: NOW - DELAYED_MAX_AGE_MS }), NOW, live)).toBe('stale');
    expect(quoteFreshness(q({ lastTickMs: NOW - 3_600_000 }), NOW, live)).toBe('stale');
  });

  it('polling streams are never live', () => {
    for (const streamStatus of ['upstream-polling', 'fallback-polling', 'idle', 'connecting']) {
      expect(quoteFreshness(q(), NOW, { streamStatus, missing: false })).toBe('delayed');
    }
    expect(
      quoteFreshness(q({ lastTickMs: NOW - 200_000 }), NOW, {
        streamStatus: 'fallback-polling',
        missing: false,
      }),
    ).toBe('stale');
  });

  it('snapshot-only quotes (no tick time) are delayed', () => {
    expect(quoteFreshness(q({ lastTickMs: null }), NOW, live)).toBe('delayed');
  });

  it('snapshot-only quotes age from the time they were updated', () => {
    const snap = (updatedMs: number) =>
      quoteFreshness(q({ lastTickMs: null }), NOW, { ...live, updatedMs });
    expect(snap(NOW - 1000)).toBe('delayed'); // never live without a tick
    expect(snap(NOW - DELAYED_MAX_AGE_MS + 1)).toBe('delayed');
    expect(snap(NOW - DELAYED_MAX_AGE_MS)).toBe('stale');
    expect(snap(NOW - 3_600_000)).toBe('stale');
  });

  it('age is measured from the newest of the tick and the update', () => {
    const old = NOW - 3_600_000;
    expect(quoteFreshness(q({ lastTickMs: old }), NOW, { ...live, updatedMs: NOW - 5000 })).toBe(
      'delayed',
    );
    expect(quoteFreshness(q({ lastTickMs: NOW - 5000 }), NOW, { ...live, updatedMs: old })).toBe(
      'live',
    );
    expect(quoteFreshness(q({ lastTickMs: old }), NOW, { ...live, updatedMs: old })).toBe('stale');
  });

  it('a recent snapshot does not make a quote live', () => {
    expect(
      quoteFreshness(q({ lastTickMs: NOW - 90_000 }), NOW, { ...live, updatedMs: NOW - 1000 }),
    ).toBe('delayed');
  });

  it('closed sessions never go stale, however old the data', () => {
    expect(
      quoteFreshness(q({ marketState: 'CLOSED', lastTickMs: null }), NOW, {
        ...live,
        updatedMs: NOW - 86_400_000,
      }),
    ).toBe('closed');
  });

  it('tolerates a tick time slightly in the future (clock skew)', () => {
    expect(quoteFreshness(q({ lastTickMs: NOW + 5000 }), NOW, live)).toBe('live');
  });

  it('crypto has no close or sessions', () => {
    const btc = (marketState: string) =>
      quoteFreshness(q({ symbol: 'BTC-USD', marketState }), NOW, live);
    expect(btc('CLOSED')).toBe('live');
    expect(btc('PRE')).toBe('live');
    expect(btc('REGULAR')).toBe('live');
    expect(quoteFreshness(q({ symbol: 'BTC-USD', lastTickMs: NOW - 300_000 }), NOW, live)).toBe(
      'stale',
    );
  });
});
