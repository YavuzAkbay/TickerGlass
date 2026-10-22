import { isExpressionSymbol } from '@tickerglass/engine';
import { commands } from '../commands/registry';
import { useT } from '../i18n';
import { eventsPath, EVENTS_TTL_MS, type EventsResponse } from '../events/api';
import { useLiveQuote } from '../quotes/hooks';
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
import { useChartView } from '../store/chartView';
import { useUiStore } from '../store/ui';
import { SessionClock } from './SessionClock';
import './symbolHeader.css';

const TEN_MIN = 10 * 60 * 1000;

/** Summary strip above the chart: symbol, last price, change and a few day stats. */
export function SymbolHeader() {
  const symbol = useChartView((s) => s.symbol);
  const expr = isExpressionSymbol(symbol);
  return <Header key={symbol} symbol={symbol} expr={expr} />;
}

function Header({ symbol, expr }: { symbol: string; expr: boolean }) {
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

  return (
    <div className="symbol-header" role="group" aria-label={t('symbolHeader.label')}>
      <button
        type="button"
        className="sh-symbol"
        aria-label={t('symbolHeader.search', { symbol })}
        data-tip={t('topbar.symbolSearch')}
        data-tip-side="bottom"
        onClick={() => commands.execute('chart.symbolSearch')}
      >
        {symbol}
      </button>
      {name ? (
        <button
          type="button"
          className="sh-name"
          aria-label={t('symbolHeader.openDetails', { symbol })}
          onClick={() => useUiStore.getState().openInspector('symbol')}
        >
          {name}
        </button>
      ) : null}
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
      {q && isNum(q.dayLow) && isNum(q.dayHigh) ? (
        <Stat
          label={t('symbolHeader.range')}
          value={`${fmtPrice(q.dayLow, d)} – ${fmtPrice(q.dayHigh, d)}`}
        />
      ) : null}
      {q && isNum(q.volume) ? (
        <Stat label={t('symbolHeader.volume')} value={fmtCompact(q.volume)} />
      ) : null}
      {nextEarn ? <Stat label={t('symbolHeader.earnings')} value={nextEarn} /> : null}
      <SessionClock />
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
