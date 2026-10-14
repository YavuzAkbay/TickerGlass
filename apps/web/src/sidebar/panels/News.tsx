import { isExpressionSymbol } from '@investopen/engine';
import { Newspaper } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { NewsItem } from '../../api/types';
import { commands } from '../../commands/registry';
import { useAppStore } from '../../store/app';
import { isFlagRef, resolveActive } from '../../watchlist/model';
import { useWatchlistPrefs } from '../../watchlist/prefs';
import { useWatchlistStore } from '../../watchlist/store';
import { relativeTime } from '../format';
import { useApi, useNow } from '../hooks';

const TWO_MIN = 2 * 60 * 1000;
const MAX_WATCHLIST_NEWS_SYMBOLS = 10;

type Mode = 'symbol' | 'watchlist';

/** First symbols of the active list (flag lists: oldest flag first). */
function useListSymbols(): string[] {
  const lists = useWatchlistStore((s) => s.lists);
  const flags = useWatchlistStore((s) => s.flags);
  const activeId = useWatchlistPrefs((s) => s.activeId);
  return useMemo(() => {
    const ref = resolveActive(activeId, lists);
    if (!ref) return [];
    const all = isFlagRef(ref)
      ? Object.entries(flags)
          .filter(([, f]) => f.color === ref.slice(5))
          .sort(([, a], [, b]) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
          .map(([sym]) => sym)
      : (lists[ref]?.items ?? []).flatMap((i) => (i.type === 'symbol' ? [i.symbol] : []));
    return all.slice(0, MAX_WATCHLIST_NEWS_SYMBOLS);
  }, [lists, flags, activeId]);
}

export function News() {
  const symbol = useAppStore((s) => s.symbol);
  // Session-only choice.
  const [mode, setMode] = useState<Mode>('symbol');
  const listSymbols = useListSymbols();
  const expression = isExpressionSymbol(symbol);
  const path =
    mode === 'symbol'
      ? expression
        ? null
        : `/news/${encodeURIComponent(symbol)}?limit=20`
      : listSymbols.length
        ? `/news?symbols=${encodeURIComponent(listSymbols.join(','))}&limit=30`
        : null;
  const news = useApi<NewsItem[]>(path, TWO_MIN);
  const now = useNow();

  const toggle = (
    <div className="wl-seg" role="group" aria-label="News source">
      {(['symbol', 'watchlist'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
          {m === 'symbol' ? 'Symbol' : 'Watchlist'}
        </button>
      ))}
    </div>
  );
  const wrap = (body: React.ReactNode) => (
    <>
      {toggle}
      {body}
    </>
  );

  if (mode === 'watchlist' && !listSymbols.length) {
    return wrap(
      <div className="rs-empty">
        <Newspaper size={36} strokeWidth={1.2} />
        <div className="rs-empty-text">Add symbols to your watchlist to see their news.</div>
      </div>,
    );
  }

  if (mode === 'symbol' && expression) {
    return wrap(
      <div className="rs-empty">
        <Newspaper size={36} strokeWidth={1.2} />
        <div className="rs-empty-text">Not available for symbol expressions</div>
      </div>,
    );
  }

  if (news.loading) {
    return wrap(
      <div className="rs-news" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="rs-news-item rs-news-skel">
            <i className="rs-skel rs-news-thumb" />
            <div className="rs-news-body">
              <i className="rs-skel" />
              <i className="rs-skel" style={{ width: '70%' }} />
              <i className="rs-skel" style={{ width: '40%' }} />
            </div>
          </div>
        ))}
      </div>,
    );
  }
  if (news.error) {
    return wrap(
      <div className="rs-pad">
        <div className="rs-error" role="alert">
          <span>News unavailable: {news.error}</span>
          <button type="button" className="io-btn rs-error-btn" onClick={news.retry}>
            Retry
          </button>
        </div>
      </div>,
    );
  }
  const items = news.data ?? [];
  if (!items.length) {
    return wrap(
      <div className="rs-empty">
        <Newspaper size={36} strokeWidth={1.2} />
        <div className="rs-empty-text">
          No news for {mode === 'symbol' ? symbol : 'your watchlist'}
        </div>
      </div>,
    );
  }
  return wrap(
    <div className="rs-news">
      {items.map((n, i) => (
        <div key={`${n.id}|${n.url}|${i}`} className="wl-news-wrap">
          <a className="rs-news-item" href={n.url} target="_blank" rel="noopener noreferrer">
            {n.thumbnail ? (
              <img
                className="rs-news-thumb"
                src={n.thumbnail}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => {
                  e.currentTarget.style.visibility = 'hidden';
                }}
              />
            ) : (
              <span className="rs-news-thumb rs-news-thumb-empty">
                <Newspaper size={18} strokeWidth={1.4} />
              </span>
            )}
            <div className="rs-news-body">
              <div className="rs-news-title">{n.title}</div>
              <div className="rs-news-meta">
                {n.publisher ? <span>{n.publisher}</span> : null}
                {n.publisher && n.time ? <span> · </span> : null}
                {n.time ? (
                  <time dateTime={new Date(n.time * 1000).toISOString()}>
                    {relativeTime(n.time, now)}
                  </time>
                ) : null}
              </div>
            </div>
          </a>
          {mode === 'watchlist' && n.symbol ? (
            <button
              type="button"
              className="wl-news-badge"
              data-testid={`wl-news-badge-${n.symbol}`}
              title={`Open ${n.symbol}`}
              onClick={() => commands.execute('chart.setSymbol', n.symbol)}
            >
              {n.symbol}
            </button>
          ) : null}
        </div>
      ))}
    </div>,
  );
}
