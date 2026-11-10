import { ChevronDown, ChevronRight } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { useCapabilities } from '../api/provider';
import { useT } from '../i18n';
import type { LiveQuote } from '../quotes/types';
import { fmtCompact, fmtPrice, isNum } from '../sidebar/format';
import { fundamentalsCache, symbolKey, type SymbolInfoStats } from './api';
import { finiteOrNull as num, rangePercent, textOrDash as text } from './helpers';
import { useCachedFetch } from './hooks';
import { ErrorLine, Skeleton } from './parts';
import { useSectionOpen } from './prefs';
import { Section } from './Section';

interface Props {
  /** The symbol to show; null while the selection is still settling. */
  symbol: string | null;
  quote: LiveQuote | undefined;
  /** False when the pane shows the market cap itself. */
  showMarketCap?: boolean;
}

/**
 * Key stats from the live quote (free), and behind "More stats" the `/fundamentals` ones
 * (P/E, beta, yield, sector): those are only asked for once that is opened.
 */
export function KeyStats({ symbol, quote, showMarketCap = true }: Props) {
  const t = useT();
  return (
    <Section id="keyStats" title={t('si.keyStats')} testId="si-keystats">
      <KeyStatsBody
        symbol={symbol ? symbolKey(symbol) : null}
        quote={quote}
        showMarketCap={showMarketCap}
      />
    </Section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="si-kv-row">
      <dt>{label}</dt>
      <dd className="rs-num">{children}</dd>
    </div>
  );
}

function KeyStatsBody({
  symbol,
  quote,
  showMarketCap,
}: {
  symbol: string | null;
  quote: LiveQuote | undefined;
  showMarketCap: boolean;
}) {
  const t = useT();
  const caps = useCapabilities();
  const [moreOpen, toggleMore] = useSectionOpen('moreStats');
  const moreId = useId();
  const canMore = caps.fundamentalsInfo;
  const fund = useCachedFetch(fundamentalsCache, symbol, canMore && moreOpen);
  // A provider without fundamentals answers 501: the disclosure then goes away.
  const showMore = canMore && !fund.unsupported;
  const info: SymbolInfoStats | undefined = fund.data;

  const marketCap = num(quote?.marketCap) ?? num(info?.marketCap);
  const avgVolume = num(quote?.averageVolume) ?? num(info?.averageVolume);
  const low = num(quote?.fiftyTwoWeekLow) ?? num(info?.fiftyTwoWeekLow);
  const high = num(quote?.fiftyTwoWeekHigh) ?? num(info?.fiftyTwoWeekHigh);
  const pos = rangePercent(quote?.last, low, high);
  const MoreChevron = moreOpen ? ChevronDown : ChevronRight;

  return (
    <>
      <dl className="si-kv" data-testid="si-keystats-rows">
        <Row label={t('si.open')}>{fmtPrice(quote?.open)}</Row>
        {showMarketCap ? <Row label={t('si.marketCap')}>{fmtCompact(marketCap)}</Row> : null}
        <Row label={t('si.avgVolume')}>{fmtCompact(avgVolume)}</Row>
      </dl>
      <div className="si-range" data-testid="si-range52">
        <div className="si-range-head">
          <span>{t('si.range52')}</span>
          <span className="rs-num">
            {fmtPrice(low)} – {fmtPrice(high)}
          </span>
        </div>
        <div className="si-range-track" aria-hidden="true">
          {pos !== null ? <span className="si-range-dot" style={{ left: `${pos}%` }} /> : null}
        </div>
      </div>

      {showMore ? (
        <>
          <button
            type="button"
            className="si-more"
            aria-expanded={moreOpen}
            aria-controls={moreId}
            onClick={toggleMore}
          >
            <MoreChevron size={12} aria-hidden="true" />
            {t('si.moreStats')}
          </button>
          <div id={moreId} hidden={!moreOpen}>
            {moreOpen ? (
              fund.loading || symbol === null ? (
                <Skeleton lines={3} />
              ) : fund.error ? (
                <ErrorLine
                  message={`${t('si.statsUnavailable')}: ${fund.error}`}
                  onRetry={fund.retry}
                />
              ) : info ? (
                <dl className="si-kv" data-testid="si-morestats-rows">
                  <Row label={t('si.pe')}>{fmtPrice(num(info.trailingPE))}</Row>
                  <Row label={t('si.forwardPe')}>{fmtPrice(num(info.forwardPE))}</Row>
                  <Row label={t('si.beta')}>{fmtPrice(num(info.beta))}</Row>
                  <Row label={t('si.dividendYield')}>
                    {isNum(info.dividendYield) ? `${fmtPrice(info.dividendYield)}%` : '—'}
                  </Row>
                  <Row label={t('si.sector')}>{text(info.sector)}</Row>
                  <Row label={t('si.industry')}>{text(info.industry)}</Row>
                </dl>
              ) : null
            ) : null}
          </div>
        </>
      ) : null}
    </>
  );
}
