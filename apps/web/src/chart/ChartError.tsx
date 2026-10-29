import { useEffect, useState } from 'react';
import { Database, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useStore } from 'zustand';
import { setActiveChart } from '../store/chart';
import { useUiStore } from '../store/ui';
import { useProviderName } from '../api/provider';
import { autoRetryDelaySeconds, classifyChartError, unsupportedText } from './errorState';
import type { ChartSession } from './session';

/** Automatic 429 retries made per session; cleared when data loads or the symbol changes. */
const autoRetries = new WeakMap<ChartSession, { symbol: string; count: number }>();

function retryCount(session: ChartSession): number {
  const symbol = session.view.getState().symbol;
  const cur = autoRetries.get(session);
  return cur && cur.symbol === symbol ? cur.count : 0;
}

/** Counts down `seconds` (nothing when null), then calls `onDone` once. */
function useCountdown(seconds: number | null, onDone: () => void): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    if (seconds === null) return;
    const end = Date.now() + seconds * 1000;
    const timer = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) {
        clearInterval(timer);
        onDone();
      }
    }, 250);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);
  return left;
}

function RateLimited({
  session,
  retryAfter,
}: {
  session: ChartSession;
  retryAfter?: number | undefined;
}) {
  const [delay] = useState(() => autoRetryDelaySeconds(retryAfter, retryCount(session) + 1));
  const left = useCountdown(delay, () => {
    autoRetries.set(session, {
      symbol: session.view.getState().symbol,
      count: retryCount(session) + 1,
    });
    session.info.setState({ error: null });
    void session.chart.reload();
  });
  return (
    <>
      <p className="chart-error-title">Rate limited</p>
      <p className="chart-error-text">
        {delay === null
          ? 'The data provider is limiting requests. Retry in a moment.'
          : `The data provider is limiting requests. Retrying in ${left} s.`}
      </p>
    </>
  );
}

/** Overlay shown over a chart cell while its last load failed. */
export function ChartError({ session }: { session: ChartSession }) {
  const error = useStore(session.info, (s) => s.error);
  const symbol = useStore(session.view, (s) => s.symbol);
  const providerName = useProviderName();
  useEffect(() => session.chart.on('dataLoaded', () => autoRetries.delete(session)), [session]);
  if (!error) return null;

  const kind = classifyChartError(error);
  const retry = () => {
    session.info.setState({ error: null });
    void session.chart.reload();
  };
  const search = () => {
    setActiveChart(session.id);
    useUiStore.getState().openDialog('symbolSearch');
  };

  return (
    <div className="chart-error" role="alert" data-kind={kind}>
      <TriangleAlert size={28} strokeWidth={1.5} aria-hidden />
      {kind === 'notFound' ? (
        <>
          <p className="chart-error-title">Symbol not found</p>
          <p className="chart-error-text">No data for {symbol}. Check the ticker and try again.</p>
          <button type="button" className="chart-error-btn" onClick={search}>
            <Search size={14} aria-hidden /> Search symbols
          </button>
        </>
      ) : kind === 'unsupported' ? (
        <>
          <p className="chart-error-title">Not available for {symbol}</p>
          <p className="chart-error-text">{unsupportedText(error.feature, providerName)}</p>
          <button type="button" className="chart-error-btn" onClick={search}>
            <Search size={14} aria-hidden /> Search symbols
          </button>
        </>
      ) : kind === 'rateLimited' ? (
        <>
          <RateLimited session={session} retryAfter={error.retryAfter} />
          <button type="button" className="chart-error-btn" onClick={retry}>
            <RefreshCw size={14} aria-hidden /> Retry now
          </button>
        </>
      ) : (
        <>
          <p className="chart-error-title">
            {kind === 'unavailable' ? 'Data unavailable' : 'Could not load chart'}
          </p>
          <p className="chart-error-text">
            {kind === 'unavailable'
              ? 'The market data source could not be reached. The symbol may be fine.'
              : error.message}
          </p>
          {kind === 'unavailable' && error.message ? (
            <p className="chart-error-detail">{error.message}</p>
          ) : null}
          <div className="chart-error-actions">
            <button type="button" className="chart-error-btn" onClick={retry}>
              <RefreshCw size={14} aria-hidden /> Retry
            </button>
            {kind === 'unavailable' ? (
              <button
                type="button"
                className="chart-error-btn secondary"
                onClick={() => useUiStore.getState().openDialog('dataSource')}
              >
                <Database size={14} aria-hidden /> Data source…
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
