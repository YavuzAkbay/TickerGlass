import { isExpressionSymbol } from '@tickerglass/engine';
import {
  AlarmClock,
  CalendarDays,
  Newspaper,
  Scissors,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { openAlertLog, useAlerts } from '../alerts/store';
import type { NewsItem } from '../api/types';
import { eventsPath, EVENTS_TTL_MS, type EventsResponse } from '../events/api';
import { useT } from '../i18n';
import { relativeTime } from '../sidebar/format';
import { useApi, useNow } from '../sidebar/hooks';
import { useChartView } from '../store/chartView';
import { useUiStore } from '../store/ui';
import { isFlagRef, resolveActive } from '../watchlist/model';
import { useWatchlistPrefs } from '../watchlist/prefs';
import { useWatchlistStore } from '../watchlist/store';
import {
  alertRows,
  buildTimeline,
  eventRows,
  newsRows,
  type TimelineKind,
  type TimelineRow,
} from './timeline-rows';

const TWO_MIN = 2 * 60 * 1000;
const MAX_WATCHLIST_SYMBOLS = 10;

type Mode = 'symbol' | 'watchlist';

const ICONS: Record<TimelineKind, LucideIcon> = {
  alert: AlarmClock,
  news: Newspaper,
  earnings: CalendarDays,
  dividend: Wallet,
  split: Scissors,
};

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
    return all.slice(0, MAX_WATCHLIST_SYMBOLS);
  }, [lists, flags, activeId]);
}

function fmtDate(t: number): string {
  return new Date(t * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function Row({ row, now, showSymbol }: { row: TimelineRow; now: number; showSymbol: boolean }) {
  const Icon = ICONS[row.kind];
  const when =
    row.kind === 'news' || row.kind === 'alert' ? relativeTime(row.t, now) : fmtDate(row.t);
  const body = (
    <>
      <span className="tl-icon" aria-hidden="true">
        <Icon size={14} strokeWidth={1.7} />
      </span>
      <span className="tl-main">
        <span className="tl-title">{row.title}</span>
        <span className="tl-meta">
          {showSymbol && row.symbol ? <span className="tl-sym">{row.symbol}</span> : null}
          {row.detail ? <span className="tl-detail">{row.detail}</span> : null}
        </span>
      </span>
      <time className="tl-when" dateTime={new Date(row.t * 1000).toISOString()}>
        {when}
      </time>
    </>
  );
  if (row.url)
    return (
      <li className="tl-row" data-kind={row.kind}>
        <a className="tl-link" href={row.url} target="_blank" rel="noopener noreferrer">
          {body}
        </a>
      </li>
    );
  if (row.entryId !== undefined) {
    const id = row.entryId;
    return (
      <li className="tl-row" data-kind={row.kind}>
        <button
          type="button"
          className="tl-link"
          onClick={() => {
            openAlertLog(id);
            useUiStore.getState().showNav('alerts');
          }}
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="tl-row" data-kind={row.kind}>
      <div className="tl-link tl-static">{body}</div>
    </li>
  );
}

/**
 * One feed for what happened and what is coming: alert fires, news, earnings,
 * dividends and splits, for the chart's symbol or the watchlist.
 */
export function Timeline() {
  const t = useT();
  const symbol = useChartView((s) => s.symbol);
  const [mode, setMode] = useState<Mode>('symbol');
  const listSymbols = useListSymbols();
  const expression = isExpressionSymbol(symbol);
  const symbols = mode === 'symbol' ? (expression ? [] : [symbol]) : listSymbols;
  const newsPath =
    mode === 'symbol'
      ? expression
        ? null
        : `/news/${encodeURIComponent(symbol)}?limit=20`
      : listSymbols.length
        ? `/news?symbols=${encodeURIComponent(listSymbols.join(','))}&limit=30`
        : null;
  const news = useApi<NewsItem[]>(newsPath, TWO_MIN);
  // Events need one request per symbol: the chart symbol only.
  const events = useApi<EventsResponse>(
    mode === 'symbol' && !expression ? eventsPath(symbol) : null,
    EVENTS_TTL_MS,
  );
  const log = useAlerts((s) => s.log);
  const now = useNow(60_000);

  const symKey = symbols.join(',');
  const rows = useMemo(() => {
    const set = new Set(symKey ? symKey.toUpperCase().split(',') : []);
    return [
      ...alertRows(log, set),
      ...newsRows(news.data ?? []),
      ...(events.data ? eventRows(events.data, symbol) : []),
    ];
  }, [log, news.data, events.data, symbol, symKey]);
  const { upcoming, past } = buildTimeline(rows, now / 1000);
  const loading = news.loading || events.loading;
  const showSymbol = mode === 'watchlist';

  return (
    <div className="tl-panel">
      <div className="wl-seg" role="group" aria-label={t('timeline.scope')}>
        {(['symbol', 'watchlist'] as const).map((m) => (
          <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
            {m === 'symbol' ? symbol : t('nav.watchlist')}
          </button>
        ))}
      </div>
      {news.error ? (
        <div className="rs-error tl-error" role="alert">
          <span>{t('timeline.newsError', { error: news.error })}</span>
          <button type="button" className="io-btn rs-error-btn" onClick={news.retry}>
            {t('nav.retry')}
          </button>
        </div>
      ) : null}
      {upcoming.length ? (
        <section aria-label={t('timeline.upcoming')}>
          <h3 className="tl-head">{t('timeline.upcoming')}</h3>
          <ul className="tl-list">
            {upcoming.map((r) => (
              <Row key={r.key} row={r} now={now} showSymbol={showSymbol} />
            ))}
          </ul>
        </section>
      ) : null}
      {past.length ? (
        <section aria-label={t('timeline.recent')}>
          <h3 className="tl-head">{t('timeline.recent')}</h3>
          <ul className="tl-list">
            {past.map((r) => (
              <Row key={r.key} row={r} now={now} showSymbol={showSymbol} />
            ))}
          </ul>
        </section>
      ) : loading ? (
        <div className="rs-skel-block" aria-busy="true" aria-label={t('nav.loading')}>
          {[0, 1, 2, 3].map((i) => (
            <i key={i} className="rs-skel" style={{ width: `${90 - i * 15}%` }} />
          ))}
        </div>
      ) : (
        <div className="rs-pad rs-muted">
          {mode === 'watchlist' && !listSymbols.length
            ? t('timeline.emptyList')
            : t('timeline.empty')}
        </div>
      )}
      {mode === 'watchlist' && listSymbols.length ? (
        <p className="tl-note">{t('timeline.watchlistNote')}</p>
      ) : null}
    </div>
  );
}
