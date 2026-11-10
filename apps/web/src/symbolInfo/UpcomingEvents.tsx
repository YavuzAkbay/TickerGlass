import { useCapabilities } from '../api/provider';
import { useNow } from '../sidebar/hooks';
import { useT } from '../i18n';
import { fmtPrice, isNum } from '../sidebar/format';
import { eventsCache, symbolKey } from './api';
import {
  daysLabel,
  daysUntil,
  dividendEvent,
  fmtEventDate,
  fmtSplitRatio,
  lastSplit,
  nextEarnings,
} from './helpers';
import { useCachedFetch } from './hooks';
import { ErrorLine, Skeleton } from './parts';
import { Section } from './Section';

interface Props {
  /** The symbol to show; null while the selection is still settling. */
  symbol: string | null;
}

/** Next earnings (with the days to go), ex-dividend date and last split, from `/events`. */
export function UpcomingEvents({ symbol }: Props) {
  const t = useT();
  const caps = useCapabilities();
  // Hidden for a provider without events; the API would only answer 501.
  if (caps.events.length === 0) return null;
  return (
    <Section id="events" title={t('si.events')} testId="si-events">
      <EventsBody symbol={symbol ? symbolKey(symbol) : null} kinds={caps.events} />
    </Section>
  );
}

function EventsBody({ symbol, kinds }: { symbol: string | null; kinds: string[] }) {
  const t = useT();
  const ev = useCachedFetch(eventsCache, symbol);
  const now = useNow();
  if (ev.unsupported) return null;
  if (!symbol || ev.loading) return <Skeleton lines={3} />;
  if (ev.error)
    return <ErrorLine message={`${t('si.eventsUnavailable')}: ${ev.error}`} onRetry={ev.retry} />;

  const data = ev.data;
  const earnings = nextEarnings(data, now);
  const dividend = dividendEvent(data, now);
  const split = lastSplit(data);
  return (
    <dl className="si-kv si-kv-wide" data-testid="si-events-rows">
      {kinds.includes('earnings') ? (
        <div className="si-kv-row" data-testid="si-next-earnings">
          <dt>{t('si.nextEarnings')}</dt>
          <dd className="rs-num">
            {earnings ? (
              <>
                {fmtEventDate(earnings.t)}
                <span className="si-when"> · {daysLabel(daysUntil(earnings.t, now), t)}</span>
                {isNum(earnings.epsEstimate) ? (
                  <span className="si-sub">
                    {t('si.epsEst', { value: fmtPrice(earnings.epsEstimate) })}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="si-none">{t('si.noEarnings')}</span>
            )}
          </dd>
        </div>
      ) : null}
      {kinds.includes('dividends') ? (
        <div className="si-kv-row" data-testid="si-ex-dividend">
          <dt>{dividend?.upcoming === false ? t('si.lastExDividend') : t('si.nextExDividend')}</dt>
          <dd className="rs-num">
            {dividend ? (
              <>
                {fmtEventDate(dividend.event.t)}
                <span className="si-when"> · {daysLabel(daysUntil(dividend.event.t, now), t)}</span>
                {isNum(dividend.event.amount) ? (
                  <span className="si-sub">{fmtPrice(dividend.event.amount, 4)}</span>
                ) : null}
              </>
            ) : (
              <span className="si-none">{t('si.noDividends')}</span>
            )}
          </dd>
        </div>
      ) : null}
      {kinds.includes('splits') ? (
        <div className="si-kv-row" data-testid="si-last-split">
          <dt>{t('si.lastSplit')}</dt>
          <dd className="rs-num">
            {split ? (
              <>
                {fmtEventDate(split.t)}
                <span className="si-sub">{fmtSplitRatio(split.ratio)}</span>
              </>
            ) : (
              <span className="si-none">{t('si.noSplits')}</span>
            )}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
