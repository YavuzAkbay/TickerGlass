import { isExpressionSymbol } from '@investopen/engine';
import { ChevronDown } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import type { Fundamentals, FundamentalsInfo, Performance, SymbolMeta } from '../../api/types';
import { useLiveQuote, useQuoteMissing } from '../../quotes/hooks';
import { useQuoteStore } from '../../quotes/store';
import { useChartView } from '../../store/chartView';
import {
  changeClass,
  decimalsForTick,
  fmtCompact,
  fmtInt,
  fmtPrice,
  fmtSigned,
  isNum,
} from '../format';
import { useApi, useNow } from '../hooks';
import { eventsPath, EVENTS_TTL_MS, type EventsResponse } from '../../events/api';
import { useFlash } from '../watchlist/columns';

const TEN_MIN = 10 * 60 * 1000;
const ONE_MIN = 60 * 1000;

/** Fields added to `/fundamentals` for Phase 8 (Yahoo `info`; times are unix seconds). */
type DetailsInfo = FundamentalsInfo & {
  priceToBook?: number | null;
  averageVolume?: number | null;
  sharesOutstanding?: number | null;
  exDividendDate?: number | null;
  earningsTimestamp?: number | null;
  earningsTimestampStart?: number | null;
  earningsTimestampEnd?: number | null;
  isEarningsDateEstimate?: boolean | null;
};

/** Unix seconds (milliseconds are tolerated) to a short date. */
function fmtDate(t: number): string {
  const ms = t > 1e11 ? t : t * 1000;
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/** Earnings row: next from events, else the estimated timestamp, else the last reported. */
export function earningsStat(
  events: EventsResponse | undefined,
  info: DetailsInfo,
  nowMs: number,
): { label: string; value: string } {
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  const startOfToday = today.getTime() / 1000;
  const list = events?.earnings ?? [];
  const upcoming = list.map((e) => e.t).filter((t) => t >= startOfToday);
  if (upcoming.length) return { label: 'Next earnings', value: fmtDate(Math.min(...upcoming)) };
  const ts = info.earningsTimestamp;
  const norm = (t: number) => (t > 1e11 ? t / 1000 : t);
  if (isNum(ts) && norm(ts) >= startOfToday) {
    const a = info.earningsTimestampStart;
    const b = info.earningsTimestampEnd;
    const range =
      isNum(a) && isNum(b) && fmtDate(a) !== fmtDate(b)
        ? `${fmtDate(a)} – ${fmtDate(b)}`
        : fmtDate(ts);
    return {
      label: 'Next earnings',
      value: info.isEarningsDateEstimate ? `${range} (est.)` : range,
    };
  }
  const reported = list.filter((e) => isNum(e.epsActual)).map((e) => e.t);
  if (reported.length) return { label: 'Last earnings', value: fmtDate(Math.max(...reported)) };
  return { label: 'Next earnings', value: '—' };
}

const PERIOD_LABELS: Record<string, string> = {
  '1W': '1W',
  '1M': '1M',
  '3M': '3M',
  '6M': '6M',
  YTD: 'YTD',
  '1Y': '1Y',
  '5Y': '5Y',
};

/** Period change; recomputed from the live price when the base close is usable. */
export function periodChange(
  live: number | null,
  baseClose: number | null,
  serverPercent: number | null,
): number | null {
  if (isNum(live) && isNum(baseClose) && baseClose > 0) return (live / baseClose - 1) * 100;
  return isNum(serverPercent) ? serverPercent : null;
}

function PerformanceGrid({ symbol, last }: { symbol: string; last: number | null }) {
  const perf = useApi<Performance>(`/performance/${encodeURIComponent(symbol)}`, ONE_MIN);
  if (perf.loading)
    return (
      <div className="rs-pad">
        <Skeleton lines={2} />
      </div>
    );
  if (perf.error || !perf.data)
    return <div className="rs-pad rs-muted">Performance unavailable</div>;
  return (
    <div className="wl-perf" data-testid="details-performance">
      {perf.data.periods.map((p) => {
        const v = periodChange(last, p.baseClose, p.changePercent);
        return (
          <div key={p.key} className="wl-perf-chip">
            <span className="wl-perf-label">{PERIOD_LABELS[p.key] ?? p.key}</span>
            <span className={`wl-perf-value rs-num ${changeClass(v)}`}>{fmtSigned(v, 2, '%')}</span>
          </div>
        );
      })}
    </div>
  );
}

function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="rs-skel-block" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => (
        <i key={i} className="rs-skel" style={{ width: `${90 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rs-error" role="alert">
      <span>{message}</span>
      <button type="button" className="io-btn rs-error-btn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rs-kv">
      <span className="rs-kv-label">{label}</span>
      <span className="rs-kv-value">{children}</span>
    </div>
  );
}

function RangeBar({
  low,
  high,
  value,
  decimals,
}: {
  low: number;
  high: number;
  value: number | null;
  decimals: number;
}) {
  const pct =
    isNum(value) && high > low
      ? Math.max(0, Math.min(100, ((value - low) / (high - low)) * 100))
      : null;
  return (
    <div
      className="rs-range"
      aria-label={`52 week range ${fmtPrice(low, decimals)} to ${fmtPrice(high, decimals)}`}
    >
      <div className="rs-range-track">
        {pct !== null ? <span className="rs-range-marker" style={{ left: `${pct}%` }} /> : null}
      </div>
      <div className="rs-range-labels rs-num">
        <span>{fmtPrice(low, decimals)}</span>
        <span>{fmtPrice(high, decimals)}</span>
      </div>
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function Details() {
  const symbol = useChartView((s) => s.symbol);
  // No quote, fundamentals or events exist for an expression: mount nothing that fetches.
  if (isExpressionSymbol(symbol))
    return (
      <div className="rs-details">
        <div className="rs-det-head">
          <div className="rs-det-ticker">
            <span className="rs-det-symbol">{symbol}</span>
            <span className="rs-badge">expression</span>
          </div>
        </div>
        <div className="rs-pad rs-muted">Not available for symbol expressions</div>
      </div>
    );
  return <SymbolDetails symbol={symbol} />;
}

function SymbolDetails({ symbol }: { symbol: string }) {
  const enc = encodeURIComponent(symbol);
  const meta = useApi<SymbolMeta>(`/symbols/${enc}`, TEN_MIN);
  const fund = useApi<Fundamentals>(`/fundamentals/${enc}`, TEN_MIN);
  const events = useApi<EventsResponse>(eventsPath(symbol), EVENTS_TTL_MS);
  const q = useLiveQuote(symbol);
  const now = useNow();
  const quoteError = useQuoteStore((s) => s.error);
  const quoteMissing = useQuoteMissing(symbol);
  const lastRef = useRef<HTMLSpanElement>(null);
  const extRef = useRef<HTMLSpanElement>(null);
  useFlash(q, lastRef, extRef);
  const [aboutOpen, setAboutOpen] = useState(false);

  const d = decimalsForTick(meta.data?.minTick);
  const info: DetailsInfo | undefined = fund.data?.info;
  const currency = meta.data?.currency ?? q?.currency ?? info?.currency ?? null;
  const cls = changeClass(q?.change);
  const last = q?.last ?? null;
  const earnings = earningsStat(events.data, info ?? {}, now);

  return (
    <div className="rs-details">
      <div className="rs-det-head">
        {meta.loading ? (
          <Skeleton lines={2} />
        ) : meta.error ? (
          <ErrorBox message={meta.error} onRetry={meta.retry} />
        ) : (
          <>
            <div className="rs-det-ticker">
              <span className="rs-det-symbol">{meta.data?.symbol ?? symbol}</span>
              {meta.data?.type ? <span className="rs-badge">{meta.data.type}</span> : null}
            </div>
            <div className="rs-det-name">{meta.data?.name ?? info?.longName ?? ''}</div>
            <div className="rs-det-sub">
              {[meta.data?.exchangeName ?? meta.data?.exchange, currency]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </>
        )}
        <div className="rs-det-price">
          {q ? (
            <>
              <span ref={lastRef} className="rs-det-last rs-num">
                {fmtPrice(last, d)}
              </span>
              {currency ? <span className="rs-det-cur">{currency}</span> : null}
              <span className={`rs-det-chg rs-num ${cls}`}>
                {fmtSigned(q.change, d)} ({fmtSigned(q.changePercent, 2, '%')})
              </span>
              {q.ext ? (
                <span className="wl-ext-line rs-num">
                  {q.ext.session === 'pre' ? 'Pre-market' : 'After hours'}{' '}
                  <span ref={extRef} className={changeClass(q.ext.change)}>
                    {fmtPrice(q.ext.price, d)} {fmtSigned(q.ext.changePercent, 2, '%')}
                  </span>
                </span>
              ) : null}
            </>
          ) : quoteError || quoteMissing ? (
            <span className="rs-muted">No quote</span>
          ) : (
            <i className="rs-skel rs-skel-price" />
          )}
        </div>
      </div>

      <div className="rs-section-title">Performance</div>
      <PerformanceGrid symbol={symbol} last={last} />

      <div className="rs-section-title">Key stats</div>
      {fund.loading ? (
        <div className="rs-pad">
          <Skeleton lines={8} />
        </div>
      ) : fund.error ? (
        <div className="rs-pad">
          <ErrorBox message={`Fundamentals unavailable: ${fund.error}`} onRetry={fund.retry} />
        </div>
      ) : info ? (
        <>
          <Stat label="Market cap">
            <span className="rs-num">
              {isNum(info.marketCap)
                ? `${fmtCompact(info.marketCap)}${currency ? ` ${currency}` : ''}`
                : '—'}
            </span>
          </Stat>
          <Stat label="P/E (TTM)">
            <span className="rs-num">{fmtPrice(info.trailingPE)}</span>
          </Stat>
          <Stat label="Forward P/E">
            <span className="rs-num">{fmtPrice(info.forwardPE)}</span>
          </Stat>
          <Stat label="EPS (TTM)">
            <span className="rs-num">{fmtPrice(info.trailingEps)}</span>
          </Stat>
          <Stat label="Dividend yield">
            <span className="rs-num">
              {isNum(info.dividendYield) ? `${fmtPrice(info.dividendYield)}%` : '—'}
            </span>
          </Stat>
          <Stat label="P/B">
            <span className="rs-num">{fmtPrice(info.priceToBook)}</span>
          </Stat>
          <Stat label="Avg volume">
            <span className="rs-num">{fmtCompact(info.averageVolume)}</span>
          </Stat>
          <Stat label="Shares outstanding">
            <span className="rs-num">{fmtCompact(info.sharesOutstanding)}</span>
          </Stat>
          <Stat label={earnings.label}>
            <span className="rs-num">{events.loading ? '…' : earnings.value}</span>
          </Stat>
          <Stat label="Ex-dividend">
            <span className="rs-num">
              {isNum(info.exDividendDate) ? fmtDate(info.exDividendDate) : '—'}
            </span>
          </Stat>
          <Stat label="Beta">
            <span className="rs-num">{fmtPrice(info.beta)}</span>
          </Stat>
          {isNum(info.fiftyTwoWeekLow) && isNum(info.fiftyTwoWeekHigh) ? (
            <div className="rs-kv rs-kv-col">
              <span className="rs-kv-label">52-week range</span>
              <RangeBar
                low={info.fiftyTwoWeekLow}
                high={info.fiftyTwoWeekHigh}
                value={last}
                decimals={d}
              />
            </div>
          ) : null}
          <Stat label="Sector">{info.sector ?? '—'}</Stat>
          <Stat label="Industry">{info.industry ?? '—'}</Stat>
          <Stat label="Employees">
            <span className="rs-num">{fmtInt(info.fullTimeEmployees)}</span>
          </Stat>
          <Stat label="Website">
            {info.website ? (
              <a href={info.website} target="_blank" rel="noopener noreferrer" className="rs-link">
                {hostOf(info.website)}
              </a>
            ) : (
              '—'
            )}
          </Stat>
          {info.longBusinessSummary ? (
            <div className="rs-about">
              <button
                type="button"
                className="rs-section-title rs-about-toggle"
                aria-expanded={aboutOpen}
                onClick={() => setAboutOpen((o) => !o)}
              >
                About
                <ChevronDown size={14} className={aboutOpen ? 'rs-rot' : ''} />
              </button>
              <p className={`rs-about-text${aboutOpen ? ' open' : ''}`}>
                {info.longBusinessSummary}
              </p>
              {aboutOpen ? null : (
                <button
                  type="button"
                  className="rs-link rs-more"
                  onClick={() => setAboutOpen(true)}
                >
                  Show more
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
