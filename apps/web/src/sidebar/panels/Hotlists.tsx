import { Flame, ScanSearch } from 'lucide-react';
import { useMemo } from 'react';
import { commands } from '../../commands/registry';
import { HotlistRows } from '../../hotlists/HotlistRows';
import { useHotlist, useListInfos } from '../../hotlists/hooks';
import {
  HOTLIST_KINDS,
  KIND_META,
  isHotlistKind,
  liveSymbols,
  resolveUniverse,
  universeOptions,
} from '../../hotlists/kinds';
import { useHotlistPrefs } from '../../hotlists/prefs';
import { useT } from '../../i18n';
import { useLiveQuotes } from '../../quotes/hooks';
import { screenerMode } from '../../screener/server/mode';
import { useScreenerStatus } from '../../screener/server/hooks';
import { useChartView } from '../../store/chartView';
import '../../hotlists/hotlists.css';

/**
 * Hotlists: top movers, volume spikes, RSI extremes, 52-week highs/lows, gaps and golden
 * crosses over a universe. The ranking comes from the screener's last close snapshot; the
 * visible rows' prices and change are live.
 */
export function Hotlists() {
  const t = useT();
  const { status, loaded } = useScreenerStatus();
  const { lists, ready } = useListInfos();
  const kind = useHotlistPrefs((s) => s.kind);
  const saved = useHotlistPrefs((s) => s.universe);
  const chartSymbol = useChartView((s) => s.symbol);

  const options = useMemo(() => universeOptions(lists), [lists]);
  const universe = ready ? resolveUniverse(saved, options) : null;
  const server = screenerMode(status) === 'server';
  const { data, error, loading, retry } = useHotlist(
    kind,
    server ? universe : null,
    status?.asOf ?? null,
  );
  const rows = data?.rows ?? [];
  const quotes = useLiveQuotes(liveSymbols(rows));
  const kindLabel = t(KIND_META[kind].label);

  const openScreener = (
    <button
      type="button"
      className="io-btn rs-empty-btn"
      data-testid="hl-open-screener"
      onClick={() => commands.execute('view.screener')}
    >
      <ScanSearch size={14} /> {t('hl.openScreener')}
    </button>
  );

  let body;
  if (!loaded) {
    body = <div className="rs-pad rs-muted">{t('hl.loading')}</div>;
  } else if (!server) {
    const building = status?.reason === 'first_run' && !!status.running;
    body = (
      <div className="rs-empty" data-testid="hl-empty">
        <Flame size={36} strokeWidth={1.2} />
        <div className="rs-empty-title">{t('hl.empty.title')}</div>
        <div className="rs-empty-text">
          {t(building ? 'hl.empty.building' : status ? 'hl.empty.noSnapshot' : 'hl.empty.offline')}
        </div>
        {openScreener}
      </div>
    );
  } else if (error && !data) {
    body = (
      <div className="rs-inline-error" role="alert">
        {error}{' '}
        <button type="button" className="io-btn rs-error-btn" onClick={retry}>
          {t('hl.retry')}
        </button>
      </div>
    );
  } else if (!data) {
    body = <div className="rs-pad rs-muted">{t('hl.loading')}</div>;
  } else if (data.asOf === null || rows.length === 0) {
    body = (
      <div className="rs-empty" data-testid="hl-none">
        <Flame size={36} strokeWidth={1.2} />
        <div className="rs-empty-title">{t('hl.none.title', { kind: kindLabel })}</div>
        <div className="rs-empty-text">{t('hl.none.text')}</div>
        {openScreener}
      </div>
    );
  } else {
    body = (
      <>
        <div className="hl-head" aria-hidden="true">
          <span>{t('hl.col.symbol')}</span>
          <span className="hl-num">{t('hl.col.last')}</span>
          <span className="hl-num">{t('hl.col.chg')}</span>
          <span className="hl-num hl-metric">{t(KIND_META[kind].metric)}</span>
        </div>
        <HotlistRows
          rows={rows}
          kind={kind}
          quotes={quotes}
          chartSymbol={chartSymbol}
          label={kindLabel}
        />
      </>
    );
  }

  return (
    <div className="hl-panel" data-testid="hl-panel">
      <div className="hl-tools">
        <select
          className="io-input hl-select"
          aria-label={t('hl.kind')}
          data-testid="hl-kind"
          value={kind}
          onChange={(e) => {
            if (isHotlistKind(e.target.value)) useHotlistPrefs.getState().setKind(e.target.value);
          }}
        >
          {HOTLIST_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(KIND_META[k].label)}
            </option>
          ))}
        </select>
        <select
          className="io-input hl-select"
          aria-label={t('hl.universe')}
          data-testid="hl-universe"
          value={universe ?? ''}
          disabled={!ready}
          onChange={(e) => useHotlistPrefs.getState().setUniverse(e.target.value)}
        >
          {universe === null ? <option value="" /> : null}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.key ? t(o.key) : o.name}
            </option>
          ))}
        </select>
      </div>
      {server && data?.asOf ? (
        <div className="hl-asof" data-testid="hl-asof">
          <span>{t('hl.asOf', { date: data.asOf })}</span>
          <span className="rs-muted">{t('hl.liveNote')}</span>
        </div>
      ) : null}
      <div className="hl-body" aria-busy={loading}>
        {body}
      </div>
    </div>
  );
}
