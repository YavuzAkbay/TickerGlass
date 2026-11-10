import { ArrowUpRight, Bell, ChartLine, Copy, FolderInput, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { commands } from '../../commands/registry';
import { useLiveQuote } from '../../quotes/hooks';
import { useT } from '../../i18n';
import { changeClass, fmtAuto, fmtCompact, fmtPrice, fmtSigned, isNum } from '../../sidebar/format';
import { flagLabel } from '../../sidebar/watchlist/rowMenu';
import { Sparkline } from '../../sidebar/watchlist/Sparkline';
import { openContextMenu } from '../../ui/ContextMenu';
import { IconButton } from '../../ui/IconButton';
import { toast } from '../../ui/Toast';
import { SymbolInfo } from '../../symbolInfo/SymbolInfo';
import { moveWithReport } from '../actions';
import { isFlagRef, sortedLists, type SymbolMeta } from '../model';
import { useWatchlistStore } from '../store';
import { FLAG_COLORS, type FlagColor, type ListRef } from '../types';
import { useSymbolMeta } from './symbolMeta';
import { DayRangeBar } from './PageSymbolRow';

const PERIODS = [
  { key: '1M', limit: 22 },
  { key: '3M', limit: 66 },
  { key: '6M', limit: 132 },
  { key: '1Y', limit: 252 },
] as const;

interface Props {
  symbol: string | null;
  listRef: ListRef;
  /** Open the symbol in the chart and return to it. */
  onOpen: (symbol: string) => void;
  /** Deselect (phones: dismiss the bottom sheet). */
  onClose?: () => void;
}

/** Right-hand pane: the focused symbol's quote, range, trend and quick actions. */
export function PageDetail({ symbol, listRef, onOpen, onClose }: Props) {
  const t = useT();
  const q = useLiveQuote(symbol);
  const meta: SymbolMeta | null = useSymbolMeta(symbol ?? '', !!symbol);
  const flags = useWatchlistStore((s) => s.flags);
  const lists = useWatchlistStore((s) => s.lists);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]['key']>('3M');
  const limit = PERIODS.find((p) => p.key === period)!.limit;

  if (!symbol)
    return (
      <div className="wlp-detail wlp-detail-none">
        <ChartLine size={30} strokeWidth={1.2} aria-hidden="true" />
        <div className="wlp-empty-title">{t('wlp.detailNoneTitle')}</div>
        <div className="wlp-empty-text">{t('wlp.detailNoneText')}</div>
      </div>
    );

  const currentFlag = flags[symbol]?.color ?? null;
  const moveMenu = (x: number, y: number) => {
    if (isFlagRef(listRef)) return;
    const entry = lists[listRef];
    if (!entry) return;
    const others = sortedLists(lists).filter((l) => l.id !== entry.id);
    openContextMenu(x, y, [
      ...others.map((l) => ({
        label: l.name,
        onSelect: () => {
          moveWithReport(entry.id, l.id, l.name, [symbol]);
        },
      })),
      ...(others.length ? [{ type: 'separator' as const }] : []),
      {
        label: 'New list…',
        icon: Plus,
        onSelect: () => commands.execute('watchlist.searchAdd'),
      },
    ]);
  };

  return (
    <div className="wlp-detail" data-testid="wlp-detail">
      <header className="wlp-detail-head">
        <div className="wlp-detail-id">
          <span className="wlp-detail-symbol rs-num">{symbol}</span>
          {meta?.name ? <span className="wlp-detail-name">{meta.name}</span> : null}
          {meta?.exchange ? <span className="wlp-detail-badge">{meta.exchange}</span> : null}
        </div>
        <div className="wlp-detail-flags" role="group" aria-label={t('wlp.flagLabel')}>
          {FLAG_COLORS.map((c: FlagColor) => (
            <button
              key={c}
              type="button"
              className={`wlp-flag-dot${currentFlag === c ? ' on' : ''}`}
              style={{ background: `var(--wl-flag-${c})` }}
              aria-label={flagLabel(c)}
              aria-pressed={currentFlag === c}
              title={flagLabel(c)}
              onClick={() =>
                commands.execute('watchlist.flag', {
                  symbol,
                  color: currentFlag === c ? null : c,
                })
              }
            />
          ))}
        </div>
        {onClose ? (
          <IconButton
            icon={X}
            size={14}
            label={t('wlp.detailClose')}
            className="wlp-detail-close"
            onClick={onClose}
          />
        ) : null}
      </header>

      <div className="wlp-detail-price">
        <span className="wlp-detail-last rs-num" data-testid="wlp-detail-last">
          {q ? fmtAuto(q.last) : '—'}
        </span>
        <span className={`wlp-detail-chg rs-num ${changeClass(q?.changePercent)}`}>
          {q && isNum(q.change) ? fmtSigned(q.change) : ''}
          {q && isNum(q.changePercent) ? ` (${fmtSigned(q.changePercent, 2, '%')})` : ''}
        </span>
        {q?.marketState ? <span className="wlp-detail-state">{q.marketState}</span> : null}
        {q?.currency ? <span className="wlp-detail-state">{q.currency}</span> : null}
      </div>

      {q?.ext ? (
        <div className="wlp-detail-ext rs-num">
          <span className="wlp-detail-ext-label">
            {q.ext.session === 'pre' ? t('wlp.preMarket') : t('wlp.postMarket')}
          </span>
          <span className={changeClass(q.ext.changePercent)}>{fmtAuto(q.ext.price)}</span>
          <span className={changeClass(q.ext.changePercent)}>
            {fmtSigned(q.ext.changePercent, 2, '%')}
          </span>
        </div>
      ) : null}

      <div className="wlp-detail-range">
        <DayRangeBar q={q} />
        <span className="wlp-range-ends rs-num">
          <span>{fmtPrice(q?.dayLow)}</span>
          <span>{fmtPrice(q?.dayHigh)}</span>
        </span>
      </div>

      <dl className="wlp-detail-kv">
        <div>
          <dt>{t('wlp.volume')}</dt>
          <dd className="rs-num">{q ? fmtCompact(q.volume) : '—'}</dd>
        </div>
        <div>
          <dt>{t('wlp.prevClose')}</dt>
          <dd className="rs-num">{fmtPrice(q?.prevClose)}</dd>
        </div>
        <div>
          <dt>{t('wlp.dayLow')}</dt>
          <dd className="rs-num">{fmtPrice(q?.dayLow)}</dd>
        </div>
        <div>
          <dt>{t('wlp.dayHigh')}</dt>
          <dd className="rs-num">{fmtPrice(q?.dayHigh)}</dd>
        </div>
      </dl>

      <div className="wlp-detail-trend">
        <div className="wlp-detail-trend-head" role="group" aria-label={t('wlp.period')}>
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
        <div className="wlp-detail-trend-body">
          <SparklineLarge symbol={symbol} limit={limit} last={q?.last} />
        </div>
      </div>

      <div className="wlp-detail-actions">
        <button type="button" className="io-btn io-btn-primary" onClick={() => onOpen(symbol)}>
          <ArrowUpRight size={14} />
          {t('wlp.openChart')}
        </button>
        <button
          type="button"
          className="io-btn"
          onClick={() => commands.execute('alert.create', { symbol })}
        >
          <Bell size={14} />
          {t('wlp.addAlert')}
        </button>
        <button
          type="button"
          className="io-btn"
          onClick={() =>
            navigator.clipboard.writeText(symbol).then(
              () => toast(`Copied ${symbol}`, 'success'),
              () => toast('Could not copy to clipboard', 'error'),
            )
          }
        >
          <Copy size={14} />
          {t('wlp.copySymbol')}
        </button>
        {!isFlagRef(listRef) && lists[listRef] ? (
          <button
            type="button"
            className="io-btn"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              moveMenu(r.left, r.bottom);
            }}
          >
            <FolderInput size={14} />
            {t('wlp.moveToList')}
          </button>
        ) : null}
        <button
          type="button"
          className="io-btn io-btn-danger"
          onClick={() => commands.execute('watchlist.remove', symbol)}
        >
          <Trash2 size={14} />
          {isFlagRef(listRef) ? t('wlp.removeFlag') : t('wlp.removeSymbol')}
        </button>
      </div>

      <SymbolInfo symbol={symbol} quote={q} withAlerts />
    </div>
  );
}

/** Bigger trend for the pane (width fits the ~340px pane). */
function SparklineLarge({
  symbol,
  limit,
  last,
}: {
  symbol: string;
  limit: number;
  last?: number | null | undefined;
}) {
  return <Sparkline symbol={symbol} width={296} height={72} limit={limit} last={last} />;
}
