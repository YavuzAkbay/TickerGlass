import { useEffect, useState } from 'react';
import { RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { useStore } from 'zustand';
import { setActiveChart } from '../store/chart';
import { useUiStore } from '../store/ui';
import { classifyChartError, retryDelaySeconds } from './errorState';
import type { ChartSession } from './session';

/** Counts down `seconds`, then calls `onDone` once. */
function useCountdown(seconds: number, onDone: () => void): number {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
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
  const left = useCountdown(retryDelaySeconds(retryAfter), () => {
    session.info.setState({ error: null });
    void session.chart.reload();
  });
  return (
    <>
      <p className="chart-error-title">Rate limited</p>
      <p className="chart-error-text">
        The data provider is limiting requests. Retrying in {left} s.
      </p>
    </>
  );
}

/** Overlay shown over a chart cell while its last load failed. */
export function ChartError({ session }: { session: ChartSession }) {
  const error = useStore(session.info, (s) => s.error);
  const symbol = useStore(session.view, (s) => s.symbol);
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
            {kind === 'unavailable' ? 'The data service could not be reached.' : error.message}
          </p>
          <button type="button" className="chart-error-btn" onClick={retry}>
            <RefreshCw size={14} aria-hidden /> Retry
          </button>
        </>
      )}
    </div>
  );
}
