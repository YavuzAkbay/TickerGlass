import { useMemo } from 'react';
import { commands } from '../../commands/registry';
import { useAppStore } from '../../store/app';
import { openContextMenu } from '../../ui/ContextMenu';
import { toast } from '../../ui/Toast';
import { changeClass, fmtAuto, fmtSigned } from '../format';
import { useQuotes } from '../hooks';

function rowMenu(symbol: string, x: number, y: number) {
  openContextMenu(x, y, [
    { label: 'Open', onSelect: () => commands.execute('chart.setSymbol', symbol) },
    {
      label: 'Copy symbol',
      onSelect: () => {
        navigator.clipboard.writeText(symbol).then(
          () => toast(`Copied ${symbol}`, 'success'),
          () => toast('Could not copy to clipboard', 'error'),
        );
      },
    },
    { type: 'separator' },
    { label: 'Add alert', onSelect: () => commands.execute('alert.create') },
    { type: 'separator' },
    {
      label: 'Remove from list',
      danger: true,
      onSelect: () =>
        useAppStore.setState((s) => ({
          recentSymbols: s.recentSymbols.filter((x) => x !== symbol),
        })),
    },
  ]);
}

/** Basic watchlist: current symbol plus recents with polled quotes (full version: Phase 8). */
export function Watchlist() {
  const symbol = useAppStore((s) => s.symbol);
  const recents = useAppStore((s) => s.recentSymbols);
  const symbols = useMemo(() => [...new Set([symbol, ...recents])], [symbol, recents]);
  const { quotes, error, loading } = useQuotes(symbols);

  return (
    <div className="rs-watchlist">
      <div className="rs-wl-head" role="row">
        <span>Symbol</span>
        <span>Last</span>
        <span>Chg</span>
        <span>Chg%</span>
      </div>
      <div role="table" aria-label="Watchlist">
        {symbols.map((s) => {
          const q = quotes[s];
          const cls = changeClass(q?.change);
          return (
            <div
              key={s}
              role="row"
              tabIndex={0}
              aria-current={s === symbol}
              className={`rs-wl-row${s === symbol ? ' current' : ''}`}
              onClick={() => commands.execute('chart.setSymbol', s)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commands.execute('chart.setSymbol', s);
                else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  rowMenu(s, r.left + 16, r.bottom);
                }
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                rowMenu(s, e.clientX, e.clientY);
              }}
            >
              <span className="rs-wl-sym">{s}</span>
              {q ? (
                <>
                  <span className="rs-num">{fmtAuto(q.last)}</span>
                  <span className={`rs-num ${cls}`}>{fmtSigned(q.change)}</span>
                  <span className={`rs-num ${cls}`}>{fmtSigned(q.changePercent, 2, '%')}</span>
                </>
              ) : (
                <>
                  <span className="rs-num">
                    {loading ? <i className="rs-skel rs-skel-num" /> : '—'}
                  </span>
                  <span className="rs-num">
                    {loading ? <i className="rs-skel rs-skel-num" /> : ''}
                  </span>
                  <span className="rs-num">
                    {loading ? <i className="rs-skel rs-skel-num" /> : ''}
                  </span>
                </>
              )}
            </div>
          );
        })}
      </div>
      {error ? <div className="rs-inline-error">Quotes unavailable: {error}</div> : null}
    </div>
  );
}
