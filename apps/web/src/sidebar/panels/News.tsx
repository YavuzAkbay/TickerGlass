import { Newspaper } from 'lucide-react';
import type { NewsItem } from '../../api/types';
import { useAppStore } from '../../store/app';
import { relativeTime } from '../format';
import { useApi, useNow } from '../hooks';

const TWO_MIN = 2 * 60 * 1000;

export function News() {
  const symbol = useAppStore((s) => s.symbol);
  const news = useApi<NewsItem[]>(`/news/${encodeURIComponent(symbol)}?limit=20`, TWO_MIN);
  const now = useNow();

  if (news.loading) {
    return (
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
      </div>
    );
  }
  if (news.error) {
    return (
      <div className="rs-pad">
        <div className="rs-error" role="alert">
          <span>News unavailable: {news.error}</span>
          <button type="button" className="io-btn rs-error-btn" onClick={news.retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }
  const items = news.data ?? [];
  if (!items.length) {
    return (
      <div className="rs-empty">
        <Newspaper size={36} strokeWidth={1.2} />
        <div className="rs-empty-text">No news for {symbol}</div>
      </div>
    );
  }
  return (
    <div className="rs-news">
      {items.map((n) => (
        <a
          key={n.id}
          className="rs-news-item"
          href={n.url}
          target="_blank"
          rel="noopener noreferrer"
        >
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
      ))}
    </div>
  );
}
