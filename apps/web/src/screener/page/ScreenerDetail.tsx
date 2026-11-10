import { ArrowUpRight, ChartLine, Copy, FolderPlus, X } from 'lucide-react';
import { useState } from 'react';
import { commands } from '../../commands/registry';
import { useLiveQuote } from '../../quotes/hooks';
import { useT } from '../../i18n';
import { changeClass, fmtAuto, fmtCompact, fmtPrice, fmtSigned, isNum } from '../../sidebar/format';
import { sortedLists } from '../../watchlist/model';
import { useWatchlistStore } from '../../watchlist/store';
import { Sparkline } from '../../sidebar/watchlist/Sparkline';
import { openContextMenu } from '../../ui/ContextMenu';
import { IconButton } from '../../ui/IconButton';
import { toast } from '../../ui/Toast';
import { SymbolInfo } from '../../symbolInfo/SymbolInfo';
import { UNIVERSE_AS_OF, type Universe } from '../universe/types';
import { ScrRangeBar } from './ResultRow';

const PERIODS = [
  { key: '1M', limit: 22 },
  { key: '3M', limit: 66 },
  { key: '6M', limit: 132 },
  { key: '1Y', limit: 252 },
] as const;

interface Props {
  symbol: string | null;
  universe: Universe;
  /** Open the symbol in the chart and return to it. */
  onOpen: (symbol: string) => void;
  onClose?: () => void;
}

/** Right-hand pane: the focused symbol's quote, static meta and quick actions. */
export function ScreenerDetail({ symbol, universe, onOpen, onClose }: Props) {
  const t = useT();
  const q = useLiveQuote(symbol);
  const entry = symbol ? universe.symbols.find((s) => s.symbol === symbol) : undefined;
  const lists = useWatchlistStore((s) => s.lists);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('3M');
  const limit = PERIODS.find((p) => p.key === period)!.limit;

  if (!symbol || !entry)
    return (
      <div className="scr-detail scr-detail-none">
        <ChartLine size={30} strokeWidth={1.2} aria-hidden="true" />
        <div className="scr-empty-title">{t('scr.detailNoneTitle')}</div>
        <div className="scr-empty-text">{t('scr.detailNoneText')}</div>
      </div>
    );

  const capLabel =
    universe.capKind === 'mcap' ? t('scr.mcap') : universe.capKind === 'aum' ? t('scr.aum') : null;

  // The universe's approximate cap stands in when the quote has none; Key stats then must not
  // add a second (empty) market-cap row.
  const universeCapShown = isNum(entry.cap) && !!capLabel && !isNum(q?.marketCap);

  const pickList = (x: number, y: number) => {
    const all = sortedLists(lists);
    openContextMenu(
      x,
      y,
      all.length
        ? all.map((l) => ({
            label: l.name,
            onSelect: () => {
              const added = useWatchlistStore.getState().addSymbols(l.id, [symbol]);
              if (added.length)
                toast(
                  t('scr.addedTo').replace('{symbol}', symbol).replace('{list}', l.name),
                  'success',
                );
              else toast(t('scr.alreadyIn').replace('{symbol}', symbol).replace('{list}', l.name));
            },
          }))
        : [{ label: t('scr.noLists'), onSelect: () => commands.execute('watchlist.create') }],
    );
  };

  return (
    <div className="scr-detail" data-testid="scr-detail">
      <header className="scr-detail-head">
        <div className="scr-detail-id">
          <span className="scr-detail-symbol rs-num">{symbol}</span>
          <span className="scr-detail-name">{entry.name}</span>
        </div>
        <div className="scr-detail-badges">
          {entry.exchange ? <span className="scr-detail-badge">{entry.exchange}</span> : null}
          <span className="scr-detail-badge">{entry.group}</span>
        </div>
        {onClose ? (
          <IconButton
            icon={X}
            size={14}
            label={t('scr.detailClose')}
            className="scr-detail-close"
            onClick={onClose}
          />
        ) : null}
      </header>

      <div className="scr-detail-price">
        <span className="scr-detail-last rs-num" data-testid="scr-detail-last">
          {q ? fmtAuto(q.last) : '—'}
        </span>
        <span className={`scr-detail-chg rs-num ${changeClass(q?.changePercent)}`}>
          {q && isNum(q.change) ? fmtSigned(q.change) : ''}
          {q && isNum(q.changePercent) ? ` (${fmtSigned(q.changePercent, 2, '%')})` : ''}
        </span>
        {q?.marketState ? <span className="scr-detail-state">{q.marketState}</span> : null}
        {q?.currency ? <span className="scr-detail-state">{q.currency}</span> : null}
      </div>

      <div className="scr-detail-range">
        <ScrRangeBar q={q} />
        <span className="scr-range-ends rs-num">
          <span>{fmtPrice(q?.dayLow)}</span>
          <span>{fmtPrice(q?.dayHigh)}</span>
        </span>
      </div>

      <dl className="scr-detail-kv">
        <div>
          <dt>{t('scr.volume')}</dt>
          <dd className="rs-num">{q ? fmtCompact(q.volume) : '—'}</dd>
        </div>
        <div>
          <dt>{t('scr.prevClose')}</dt>
          <dd className="rs-num">{fmtPrice(q?.prevClose)}</dd>
        </div>
        <div>
          <dt>{t('scr.dayLow')}</dt>
          <dd className="rs-num">{fmtPrice(q?.dayLow)}</dd>
        </div>
        <div>
          <dt>{t('scr.dayHigh')}</dt>
          <dd className="rs-num">{fmtPrice(q?.dayHigh)}</dd>
        </div>
        {universeCapShown && isNum(entry.cap) ? (
          <div>
            <dt>
              {capLabel}
              <span className="scr-kv-note" title={t('scr.asOf').replace('{date}', UNIVERSE_AS_OF)}>
                ≈
              </span>
            </dt>
            <dd className="rs-num">${fmtCompact(entry.cap * 1e9)}</dd>
          </div>
        ) : null}
        <div>
          <dt>{t('scr.rank')}</dt>
          <dd className="rs-num">#{entry.rank}</dd>
        </div>
      </dl>

      <div className="scr-detail-trend">
        <div className="scr-detail-trend-head" role="group" aria-label={t('scr.period')}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={period === p.key}
              onClick={() => setPeriod(p.key)}
            >
              {p.key}
            </button>
          ))}
        </div>
        <div className="scr-detail-trend-body">
          <Sparkline symbol={symbol} width={296} height={72} limit={limit} last={q?.last} />
        </div>
      </div>

      <div className="scr-detail-actions">
        <button type="button" className="io-btn io-btn-primary" onClick={() => onOpen(symbol)}>
          <ArrowUpRight size={14} />
          {t('scr.openChart')}
        </button>
        <button
          type="button"
          className="io-btn"
          data-testid="scr-detail-watchlist"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            pickList(r.left, r.bottom);
          }}
        >
          <FolderPlus size={14} />
          {t('scr.addWatchlist')}
        </button>
        <button
          type="button"
          className="io-btn"
          onClick={() =>
            navigator.clipboard.writeText(symbol).then(
              () => toast(t('scr.copied').replace('{symbol}', symbol), 'success'),
              () => toast(t('scr.copyFail'), 'error'),
            )
          }
        >
          <Copy size={14} />
          {t('scr.copySymbol')}
        </button>
      </div>

      <SymbolInfo symbol={symbol} quote={q} showMarketCap={!universeCapShown} />
    </div>
  );
}
