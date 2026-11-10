import { useLiveQuotes } from '../../quotes/hooks';
import { useT } from '../../i18n';
import { changeClass, fmtSigned } from '../../sidebar/format';
import { summarize } from '../../quotes/summary';

/** Live breadth of the (filtered) list: advancers/decliners, average, extremes. */
export function OverviewStrip({ symbols }: { symbols: string[] }) {
  const t = useT();
  const quotes = useLiveQuotes(symbols);
  const s = summarize(symbols, quotes);
  if (!s.total) return null;
  return (
    <div className="wlp-overview" data-testid="wlp-overview">
      <span className="wlp-ov-item">{t('wlp.ovSymbols').replace('{count}', String(s.count))}</span>
      <span className="wlp-ov-sep" aria-hidden="true">
        ·
      </span>
      <span className="wlp-ov-item up">{t('wlp.ovUp').replace('{n}', String(s.up))}</span>
      <span className="wlp-ov-item down">{t('wlp.ovDown').replace('{n}', String(s.down))}</span>
      {s.flat ? (
        <span className="wlp-ov-item">{t('wlp.ovFlat').replace('{n}', String(s.flat))}</span>
      ) : null}
      {s.avgChange !== null ? (
        <>
          <span className="wlp-ov-sep" aria-hidden="true">
            ·
          </span>
          <span className="wlp-ov-item">
            {t('wlp.ovAvg')}{' '}
            <span className={`rs-num ${changeClass(s.avgChange)}`}>
              {fmtSigned(s.avgChange, 2, '%')}
            </span>
          </span>
        </>
      ) : null}
      {s.top && s.top.changePercent > 0 ? (
        <span className="wlp-ov-item wlp-ov-mover">
          {t('wlp.ovTop')} <b className="rs-num">{s.top.symbol}</b>{' '}
          <span className="rs-num up">{fmtSigned(s.top.changePercent, 2, '%')}</span>
        </span>
      ) : null}
      {s.bottom && s.bottom.changePercent < 0 ? (
        <span className="wlp-ov-item wlp-ov-mover">
          {t('wlp.ovBottom')} <b className="rs-num">{s.bottom.symbol}</b>{' '}
          <span className="rs-num down">{fmtSigned(s.bottom.changePercent, 2, '%')}</span>
        </span>
      ) : null}
    </div>
  );
}
