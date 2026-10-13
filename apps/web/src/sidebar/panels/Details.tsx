import { ChevronDown } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { Fundamentals, SymbolMeta } from '../../api/types';
import { useAppStore } from '../../store/app';
import {
  changeClass,
  decimalsForTick,
  fmtCompact,
  fmtInt,
  fmtPrice,
  fmtSigned,
  isNum,
} from '../format';
import { useApi, useQuotes } from '../hooks';

const TEN_MIN = 10 * 60 * 1000;

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
  const symbol = useAppStore((s) => s.symbol);
  const enc = encodeURIComponent(symbol);
  const meta = useApi<SymbolMeta>(`/symbols/${enc}`, TEN_MIN);
  const fund = useApi<Fundamentals>(`/fundamentals/${enc}`, TEN_MIN);
  const symbols = useMemo(() => [symbol], [symbol]);
  const { quotes, loading: quoteLoading } = useQuotes(symbols);
  const [aboutOpen, setAboutOpen] = useState(false);

  const q = quotes[symbol];
  const d = decimalsForTick(meta.data?.minTick);
  const info = fund.data?.info;
  const currency = meta.data?.currency ?? q?.currency ?? info?.currency ?? null;
  const cls = changeClass(q?.change);
  const last = q?.last ?? null;

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
              <span className="rs-det-last rs-num">{fmtPrice(last, d)}</span>
              {currency ? <span className="rs-det-cur">{currency}</span> : null}
              <span className={`rs-det-chg rs-num ${cls}`}>
                {fmtSigned(q.change, d)} ({fmtSigned(q.changePercent, 2, '%')})
              </span>
            </>
          ) : quoteLoading ? (
            <i className="rs-skel rs-skel-price" />
          ) : (
            <span className="rs-muted">No quote</span>
          )}
        </div>
      </div>

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
