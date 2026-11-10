import { useT } from '../i18n';
import type { PerformancePeriod } from '../api/types';
import { useLiveQuote } from '../quotes/hooks';
import { changeClass, fmtSigned } from '../sidebar/format';
import { performanceCache, symbolKey } from './api';
import { useCachedFetch } from './hooks';
import { periodReturn } from './helpers';
import { Empty, ErrorLine, Skeleton } from './parts';
import { Section } from './Section';

/** Returns shown, in this order (5Y stays in the Details panel). */
export const STRIP_PERIODS: PerformancePeriod['key'][] = ['1W', '1M', '3M', '6M', 'YTD', '1Y'];

interface Props {
  /** The symbol to show; null while the selection is still settling. */
  symbol: string | null;
}

/** 1W..1Y returns as chips. The sign is written out, so colour is never the only cue. */
export function PerformanceStrip({ symbol }: Props) {
  const t = useT();
  const key = symbol ? symbolKey(symbol) : null;
  const q = useLiveQuote(symbol);
  return (
    <Section id="performance" title={t('si.performance')} testId="si-performance">
      <PerformanceBody
        symbolKey={key}
        last={q?.last ?? null}
        unavailable={t('si.perfUnavailable')}
      />
    </Section>
  );
}

function PerformanceBody({
  symbolKey: key,
  last,
  unavailable,
}: {
  symbolKey: string | null;
  last: number | null;
  unavailable: string;
}) {
  const perf = useCachedFetch(performanceCache, key);
  if (!key || perf.loading) return <Skeleton lines={2} />;
  if (perf.error)
    return <ErrorLine message={`${unavailable}: ${perf.error}`} onRetry={perf.retry} />;
  const periods = perf.data?.periods ?? [];
  const shown = STRIP_PERIODS.map((k) => periods.find((p) => p.key === k)).filter(
    (p): p is PerformancePeriod => !!p,
  );
  if (!shown.length) return <Empty>{unavailable}</Empty>;
  return (
    <ul className="si-perf" data-testid="si-perf-chips">
      {shown.map((p) => {
        const v = periodReturn(last, p.baseClose, p.changePercent);
        return (
          <li key={p.key} className="si-chip" data-period={p.key}>
            <span className="si-chip-label">{p.key}</span>
            <span className={`si-chip-value rs-num ${changeClass(v)}`}>{fmtSigned(v, 2, '%')}</span>
          </li>
        );
      })}
    </ul>
  );
}
