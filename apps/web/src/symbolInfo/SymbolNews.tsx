import { useCapabilities } from '../api/provider';
import type { NewsItem } from '../api/types';
import { useT } from '../i18n';
import { useNow } from '../sidebar/hooks';
import { newsCache, NEWS_LIMIT, symbolKey } from './api';
import { plainText, relativeTime, safeHttpUrl } from './helpers';
import { useCachedFetch } from './hooks';
import { Empty, ErrorLine, Skeleton } from './parts';
import { Section } from './Section';

interface Props {
  /** The symbol to show; null while the selection is still settling. */
  symbol: string | null;
  limit?: number;
}

/**
 * Latest headlines. Everything from the feed is rendered as text, and a link is only followed
 * when it is http(s); an item without a usable link is shown, not clickable.
 */
export function SymbolNews({ symbol, limit = NEWS_LIMIT }: Props) {
  const t = useT();
  const caps = useCapabilities();
  if (!caps.news) return null;
  return (
    <Section id="news" title={t('si.news')} testId="si-news">
      <NewsBody symbol={symbol ? symbolKey(symbol) : null} limit={limit} />
    </Section>
  );
}

function NewsBody({ symbol, limit }: { symbol: string | null; limit: number }) {
  const t = useT();
  const news = useCachedFetch(newsCache, symbol);
  const now = useNow();
  if (news.unsupported) return null;
  if (!symbol || news.loading) return <Skeleton lines={4} />;
  if (news.error)
    return <ErrorLine message={`${t('si.newsUnavailable')}: ${news.error}`} onRetry={news.retry} />;
  const items = (news.data ?? [])
    .map((n, i) => toView(n, i, now, t))
    .filter((n): n is NewsView => n !== null)
    .slice(0, limit);
  if (!items.length) return <Empty>{t('si.noNews')}</Empty>;
  return (
    <ul className="si-news" data-testid="si-news-list">
      {items.map((n) => (
        <li key={n.key} className="si-news-item">
          {n.href ? (
            <a
              className="si-news-title"
              href={n.href}
              target="_blank"
              rel="noopener noreferrer"
              title={`${n.title} (${t('si.opensNewTab')})`}
            >
              {n.title}
            </a>
          ) : (
            <span className="si-news-title">{n.title}</span>
          )}
          <span className="si-news-meta">{[n.source, n.age].filter(Boolean).join(' · ')}</span>
        </li>
      ))}
    </ul>
  );
}

interface NewsView {
  key: string;
  title: string;
  source: string;
  age: string;
  href: string | null;
}

function toView(
  n: NewsItem,
  index: number,
  now: number,
  t: Parameters<typeof relativeTime>[2],
): NewsView | null {
  const title = plainText(n?.title, 240);
  if (!title) return null;
  return {
    key: `${index}|${n.id ?? ''}|${n.url ?? ''}`,
    title,
    source: plainText(n.publisher, 60),
    age: relativeTime(n.time, now, t),
    href: safeHttpUrl(n.url),
  };
}
