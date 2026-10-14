/**
 * Pure merge of the three quote sources: `/quotes` snapshots, `/ws` ticks and
 * `/quotes/extended` snapshots (`now` is injected so tests are deterministic).
 */
import type { Quote } from '../api/types';
import type { ExtendedQuote, ExtQuote, ExtSession, LiveQuote, TickFrame } from './types';

/** A tick this recent beats a snapshot (snapshot `time` is a daily-bar stamp). */
export const FRESH_TICK_MS = 60_000;
/** An extended tick this recent is not replaced by an extended snapshot. */
export const FRESH_EXT_TICK_MS = 120_000;

export const emptyQuote = (symbol: string): LiveQuote => ({
  symbol,
  last: null,
  prevClose: null,
  change: null,
  changePercent: null,
  volume: null,
  dayHigh: null,
  dayLow: null,
  currency: null,
  marketState: null,
  ext: null,
  lastTickMs: null,
  flash: null,
});

const pct = (change: number, base: number): number | null =>
  base > 0 ? (change / base) * 100 : null;

function flashOf(
  prev: LiveQuote | undefined,
  old: number | null | undefined,
  price: number,
  target: 'last' | 'ext',
): LiveQuote['flash'] {
  if (old === null || old === undefined || old === price) return prev?.flash ?? null;
  return { dir: price > old ? 1 : -1, seq: (prev?.flash?.seq ?? 0) + 1, target };
}

export function mergeSnapshot(prev: LiveQuote | undefined, q: Quote, now: number): LiveQuote {
  const base = prev ?? emptyQuote(q.symbol);
  const fresh = base.lastTickMs !== null && now - base.lastTickMs < FRESH_TICK_MS;
  return {
    ...base,
    prevClose: q.prevClose ?? base.prevClose,
    currency: q.currency ?? base.currency,
    marketState: q.marketState ?? base.marketState,
    ...(fresh
      ? {}
      : {
          last: q.last,
          change: q.change,
          changePercent: q.changePercent,
          volume: q.volume,
        }),
  };
}

export function mergeTick(prev: LiveQuote | undefined, t: TickFrame): LiveQuote {
  const base = prev ?? emptyQuote(t.symbol);
  const mh = t.marketHours;
  if (mh === 0 || mh === 2 || mh === 3) {
    const session: ExtSession = mh === 0 ? 'pre' : 'post';
    const ref = base.last;
    const change = ref !== null ? t.price - ref : null;
    const ext: ExtQuote = {
      session,
      price: t.price,
      change,
      changePercent: change !== null && ref !== null ? pct(change, ref) : null,
      timeMs: t.time,
      source: 'tick',
    };
    return { ...base, ext, flash: flashOf(prev, base.ext?.price, t.price, 'ext') };
  }
  let change = t.change;
  let changePercent = t.changePercent;
  if (change === null && base.prevClose !== null) {
    change = t.price - base.prevClose;
    changePercent = pct(change, base.prevClose);
  } else if (change !== null && changePercent === null && base.prevClose !== null) {
    changePercent = pct(change, base.prevClose);
  }
  return {
    ...base,
    last: t.price,
    change,
    changePercent,
    volume: t.dayVolume ?? base.volume,
    dayHigh: t.dayHigh ?? base.dayHigh,
    dayLow: t.dayLow ?? base.dayLow,
    lastTickMs: t.time,
    ext: mh === 1 ? null : base.ext,
    flash: flashOf(prev, base.last, t.price, 'last'),
  };
}

export function mergeExtended(
  prev: LiveQuote | undefined,
  e: ExtendedQuote,
  nowMs: number,
): LiveQuote {
  const base = prev ?? emptyQuote(e.symbol);
  const state = e.marketState;
  const next: LiveQuote = { ...base, marketState: state ?? base.marketState };
  if (state === 'REGULAR') return { ...next, ext: null };
  const protectedTick =
    base.ext !== null && base.ext.source === 'tick' && nowMs - base.ext.timeMs < FRESH_EXT_TICK_MS;
  if (protectedTick) return next;
  let ext: ExtQuote | null = null;
  if (state === 'PRE' || state === 'PREPRE') {
    if (e.preMarketPrice !== null)
      ext = {
        session: 'pre',
        price: e.preMarketPrice,
        change: e.preMarketChange,
        changePercent: e.preMarketChangePercent,
        timeMs: (e.preMarketTime ?? 0) * 1000,
        source: 'snapshot',
      };
  } else if (state === 'POST' || state === 'POSTPOST' || state === 'CLOSED') {
    if (
      e.postMarketPrice !== null &&
      e.postMarketTime !== null &&
      e.regularMarketTime !== null &&
      e.postMarketTime > e.regularMarketTime
    )
      ext = {
        session: 'post',
        price: e.postMarketPrice,
        change: e.postMarketChange,
        changePercent: e.postMarketChangePercent,
        timeMs: e.postMarketTime * 1000,
        source: 'snapshot',
      };
  }
  return { ...next, ext };
}
