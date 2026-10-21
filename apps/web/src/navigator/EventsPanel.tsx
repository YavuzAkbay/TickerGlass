import { isExpressionSymbol } from '@tickerglass/engine';
import { eventsPath, EVENTS_TTL_MS, type EventsResponse } from '../events/api';
import { useT } from '../i18n';
import { useChartView } from '../store/chartView';
import { fmtPrice, fmtSigned, isNum } from '../sidebar/format';
import { useApi, useNow } from '../sidebar/hooks';
import { earningsStat } from '../sidebar/panels/Details';

type Kind = 'earnings' | 'dividend' | 'split';

interface Row {
  key: string;
  t: number;
  kind: Kind;
  detail: string;
}

/** Unix seconds (milliseconds are tolerated) to a short date. */
function fmtDate(t: number): string {
  const ms = t > 1e11 ? t : t * 1000;
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** "4:1" for a ratio of 4, "1:2" for 0.5. */
function fmtRatio(r: number | null): string {
  if (!isNum(r) || r <= 0) return '—';
  return r >= 1 ? `${+r.toFixed(4)}:1` : `1:${+(1 / r).toFixed(4)}`;
}

function toRows(ev: EventsResponse): Row[] {
  const rows: Row[] = [];
  for (const e of ev.earnings ?? []) {
    const parts: string[] = [];
    if (isNum(e.epsActual)) parts.push(`EPS ${fmtPrice(e.epsActual)}`);
    if (isNum(e.epsEstimate)) parts.push(`est. ${fmtPrice(e.epsEstimate)}`);
    if (isNum(e.surprisePercent)) parts.push(fmtSigned(e.surprisePercent, 1, '%'));
    rows.push({ key: `e${e.t}`, t: e.t, kind: 'earnings', detail: parts.join(' · ') || '—' });
  }
  for (const d of ev.dividends ?? []) {
    rows.push({
      key: `d${d.t}`,
      t: d.t,
      kind: 'dividend',
      detail: isNum(d.amount) ? fmtPrice(d.amount, 4) : '—',
    });
  }
  for (const s of ev.splits ?? []) {
    rows.push({ key: `s${s.t}`, t: s.t, kind: 'split', detail: fmtRatio(s.ratio) });
  }
  return rows.sort((a, b) => b.t - a.t);
}

/** Earnings, dividends and splits of the current symbol, newest first. */
export function EventsPanel() {
  const t = useT();
  const symbol = useChartView((s) => s.symbol);
  const events = useApi<EventsResponse>(
    isExpressionSymbol(symbol) ? null : eventsPath(symbol),
    EVENTS_TTL_MS,
  );
  const now = useNow(60_000);

  if (events.loading) {
    return (
      <div className="rs-skel-block" aria-busy="true" aria-label={t('nav.loading')}>
        {[0, 1, 2].map((i) => (
          <i key={i} className="rs-skel" style={{ width: `${90 - i * 17}%` }} />
        ))}
      </div>
    );
  }
  if (events.error) {
    return (
      <div className="rs-error" role="alert">
        <span>{events.error}</span>
        <button type="button" className="io-btn rs-error-btn" onClick={events.retry}>
          {t('nav.retry')}
        </button>
      </div>
    );
  }
  const rows = toRows(events.data ?? {});
  if (!rows.length) return <div className="rs-pad rs-muted">{t('nav.events.none')}</div>;
  const next = earningsStat(events.data, {}, now);
  return (
    <div className="nav-events">
      {next.value !== '—' ? (
        <div className="nav-events-next">
          <span className="rs-muted">{next.label}</span>
          <span className="rs-num">{next.value}</span>
        </div>
      ) : null}
      <ul className="nav-events-list">
        {rows.map((r) => (
          <li key={r.key} className="nav-events-row" data-kind={r.kind}>
            <span className="nav-events-date rs-num">{fmtDate(r.t)}</span>
            <span className="nav-events-kind">{t(`nav.events.${r.kind}`)}</span>
            <span className="nav-events-detail rs-num">{r.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
