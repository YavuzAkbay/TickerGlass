import { isExpressionSymbol } from '@tickerglass/engine';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import type { ChartSession } from '../chart/session';
import { commands } from '../commands/registry';
import { useT } from '../i18n';
import { eventsPath, EVENTS_TTL_MS, type EventsResponse } from '../events/api';
import { useLiveQuote } from '../quotes/hooks';
import type { LiveQuote } from '../quotes/types';
import type { SymbolMeta } from '../api/types';
import {
  changeClass,
  decimalsForTick,
  fmtCompact,
  fmtPrice,
  fmtSigned,
  isNum,
} from '../sidebar/format';
import { useApi, useNow } from '../sidebar/hooks';
import { earningsStat } from '../sidebar/panels/Details';
import { setActiveChart } from '../store/chart';
import { useUiStore } from '../store/ui';
import { SessionClock } from './SessionClock';
import './symbolCard.css';

const TEN_MIN = 10 * 60 * 1000;

/** Glass card at the top-left of a chart: symbol, price, change, market state and the day's range. */
export function SymbolCard({ session }: { session: ChartSession }) {
  const symbol = useStore(session.view, (s) => s.symbol);
  const slot = session.chart.getLegendSlot('main', 'header');
  if (!slot) return null;
  return createPortal(
    <Card key={symbol} session={session} symbol={symbol} expr={isExpressionSymbol(symbol)} />,
    slot,
  );
}

type MarketState = 'open' | 'extended' | 'closed' | null;

function marketState(q: LiveQuote | undefined): MarketState {
  const s = q?.marketState?.toUpperCase();
  if (!s) return null;
  if (s === 'REGULAR') return 'open';
  if (s.startsWith('PRE') || s.startsWith('POST')) return 'extended';
  return 'closed';
}

const STATE_LABEL: Record<Exclude<MarketState, null>, string> = {
  open: 'Market open',
  extended: 'Extended hours',
  closed: 'Market closed',
};

/** Low-to-high bar of the day with a tick at the last price. */
function DayRange({ low, high, last, d }: { low: number; high: number; last: number; d: number }) {
  const t = useT();
  const span = high - low;
  const pos = span > 0 ? Math.min(1, Math.max(0, (last - low) / span)) : 0.5;
  return (
    <span
      className="sc-range"
      role="img"
      aria-label={`${t('symbolHeader.range')} ${fmtPrice(low, d)} to ${fmtPrice(high, d)}`}
    >
      <span className="sc-range-num">{fmtPrice(low, d)}</span>
      <span className="sc-range-track">
        <span className="sc-range-tick" style={{ left: `${pos * 100}%` }} />
      </span>
      <span className="sc-range-num">{fmtPrice(high, d)}</span>
    </span>
  );
}

function Card({ session, symbol, expr }: { session: ChartSession; symbol: string; expr: boolean }) {
  const t = useT();
  const enc = encodeURIComponent(symbol);
  const meta = useApi<SymbolMeta>(expr ? null : `/symbols/${enc}`, TEN_MIN);
  const events = useApi<EventsResponse>(expr ? null : eventsPath(symbol), EVENTS_TTL_MS);
  const q = useLiveQuote(expr ? null : symbol);
  const now = useNow();
  const d = decimalsForTick(meta.data?.minTick);
  const cls = changeClass(q?.change);
  const glyph = isNum(q?.change) ? (q.change > 0 ? '▲' : q.change < 0 ? '▼' : '') : '';
  const abs = isNum(q?.change) ? fmtSigned(q.change, d) : null;
  const pct = isNum(q?.changePercent) ? fmtSigned(q.changePercent, 2, '%') : null;
  const earn = events.data ? earningsStat(events.data, {}, now) : null;
  const nextEarn = earn && earn.label === 'Next earnings' && earn.value !== '—' ? earn.value : null;
  const name = meta.data?.name;
  const state = marketState(q);
  const source = meta.data?.exchangeName ?? meta.data?.exchange;
  const focus = () => setActiveChart(session.id);

  return (
    <div className="sc-card" role="group" aria-label={t('symbolHeader.label')}>
      <div className="sc-top">
        <button
          type="button"
          className="sh-symbol"
          aria-label={t('symbolHeader.search', { symbol })}
          data-tip={t('topbar.symbolSearch')}
          data-tip-side="bottom"
          onClick={() => {
            focus();
            commands.execute('chart.symbolSearch');
          }}
        >
          {symbol}
        </button>
        {state ? (
          <span
            className={`sc-dot ${state}`}
            role="img"
            aria-label={STATE_LABEL[state]}
            title={STATE_LABEL[state]}
          />
        ) : null}
        {name ? (
          <button
            type="button"
            className="sh-name"
            aria-label={t('symbolHeader.openDetails', { symbol })}
            onClick={() => {
              focus();
              useUiStore.getState().openInspector('symbol');
            }}
          >
            {name}
          </button>
        ) : null}
        <SessionClock session={session} />
      </div>
      <div className="sc-price">
        {q && isNum(q.last) ? (
          <>
            <span className="sh-last">{fmtPrice(q.last, d)}</span>
            {abs !== null ? (
              <span className={`sh-change ${cls}`}>
                {glyph ? <span aria-hidden>{glyph}</span> : null} {abs}
                {pct ? ` (${pct})` : ''}
              </span>
            ) : null}
          </>
        ) : null}
        {q && isNum(q.dayLow) && isNum(q.dayHigh) && isNum(q.last) ? (
          <DayRange low={q.dayLow} high={q.dayHigh} last={q.last} d={d} />
        ) : null}
        {q && isNum(q.volume) ? (
          <Stat label={t('symbolHeader.volume')} value={fmtCompact(q.volume)} />
        ) : null}
        {nextEarn ? <Stat label={t('symbolHeader.earnings')} value={nextEarn} /> : null}
        {source ? (
          <span className="sc-source" title="Exchange / data source">
            {source}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="sh-stat">
      <span className="sh-stat-label">{label}</span>
      <span className="sh-stat-value">{value}</span>
    </span>
  );
}
