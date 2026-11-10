import { Pause, Play, X } from 'lucide-react';
import { useT, type MessageKey } from '../../i18n';
import { useLiveQuotes } from '../../quotes/hooks';
import { changeClass, fmtCompact, fmtSigned } from '../../sidebar/format';
import { summarize } from '../../quotes/summary';
import type { ScreenerFilters } from '../model';
import type { ScreenerClass } from '../universe/types';

interface Props {
  cls: ScreenerClass;
  /** Symbols in the scanned slice (the breadth population). */
  scanSymbols: string[];
  filters: ScreenerFilters;
  onFilters: (f: ScreenerFilters) => void;
  /** "Top 100 of 500" info line. */
  universeInfo: string;
  /** "Live filters evaluated on N subscribed symbols" (only while quote bounds are set). */
  liveNote: string | null;
  /** The sort order is re-applied as quotes change (false while held or paused). */
  sortLive: boolean;
  /** The user paused the live order (the toggle's state). */
  manualPause: boolean;
  /** Why the order is held right now, for the tooltip (null when live or paused by hand). */
  holdReason: 'pointer' | 'focus' | 'menu' | null;
  onTogglePause: () => void;
  /** True until the first quotes arrived. */
  loading: boolean;
}

/**
 * Between toolbar and table: live breadth of the scanned slice, the universe
 * size line, and the active filter chips (each removable).
 */
export function ScanStrip({
  cls,
  scanSymbols,
  filters,
  onFilters,
  universeInfo,
  liveNote,
  sortLive,
  manualPause,
  holdReason,
  onTogglePause,
  loading,
}: Props) {
  const t = useT();
  const quotes = useLiveQuotes(scanSymbols);
  const s = summarize(scanSymbols, quotes);
  const hasChips = countChips(filters) > 0;

  return (
    <div className="scr-strip" data-testid="scr-strip">
      <span className={`scr-strip-pulse${loading ? ' on' : ''}`} aria-hidden="true" />
      {s.count ? (
        <span className="scr-breadth" data-testid="scr-overview">
          <span className="rs-num up">{t('scr.ovUp').replace('{n}', String(s.up))}</span>
          <span className="rs-num down">{t('scr.ovDown').replace('{n}', String(s.down))}</span>
          {s.flat ? (
            <span className="rs-num muted">{t('scr.ovFlat').replace('{n}', String(s.flat))}</span>
          ) : null}
          {s.avgChange !== null ? (
            <span className="scr-ov-avg">
              {t('scr.ovAvg')}{' '}
              <span className={`rs-num ${changeClass(s.avgChange)}`}>
                {fmtSigned(s.avgChange, 2, '%')}
              </span>
            </span>
          ) : null}
          {s.top && s.top.changePercent > 0 ? (
            <span className="scr-ov-mover">
              {t('scr.ovTop')} <b className="rs-num">{shortSym(s.top.symbol, cls)}</b>{' '}
              <span className="rs-num up">{fmtSigned(s.top.changePercent, 2, '%')}</span>
            </span>
          ) : null}
          {s.bottom && s.bottom.changePercent < 0 ? (
            <span className="scr-ov-mover">
              {t('scr.ovBottom')} <b className="rs-num">{shortSym(s.bottom.symbol, cls)}</b>{' '}
              <span className="rs-num down">{fmtSigned(s.bottom.changePercent, 2, '%')}</span>
            </span>
          ) : null}
        </span>
      ) : (
        <span className="scr-strip-hint">{loading ? t('scr.loading') : t('scr.waiting')}</span>
      )}
      <span className="scr-strip-spacer" />
      {hasChips ? (
        <div className="scr-chips" role="list" aria-label={t('scr.activeFilters')}>
          {chips(filters, t).map(([key, label]) => (
            <span key={key} className="scr-chip" role="listitem">
              {label}
              <button
                type="button"
                aria-label={t('scr.removeFilter').replace('{filter}', label)}
                onClick={() => onFilters(clearChip(filters, key))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          <button
            type="button"
            className="scr-chip-clear"
            onClick={() => onFilters(clearAll(filters))}
          >
            {t('scr.clearFilters')}
          </button>
        </div>
      ) : null}
      {liveNote ? (
        <span
          className="scr-live-note rs-num"
          data-testid="scr-live-note"
          title={t('scr.liveNoteHint')}
        >
          {liveNote}
        </span>
      ) : null}
      <span className="scr-universe-info rs-num" data-testid="scr-universe-info">
        {universeInfo}
      </span>
      <button
        type="button"
        className={`scr-live-toggle${sortLive ? ' on' : ''}`}
        aria-pressed={manualPause}
        data-testid="scr-live-toggle"
        title={
          manualPause
            ? t('scr.pausedSortTitle')
            : sortLive
              ? t('scr.liveSortTitle')
              : holdReason === 'menu'
                ? t('scr.heldMenuTitle')
                : holdReason === 'focus'
                  ? t('scr.heldFocusTitle')
                  : t('scr.heldPointerTitle')
        }
        onClick={onTogglePause}
      >
        {sortLive ? <Play size={10} aria-hidden="true" /> : <Pause size={10} aria-hidden="true" />}
        {sortLive ? t('scr.liveSort') : t('scr.pausedSort')}
      </button>
    </div>
  );
}

const shortSym = (symbol: string, cls: ScreenerClass): string =>
  cls === 'commodities' ? symbol.replace('=F', '') : symbol;

const countChips = (f: ScreenerFilters): number =>
  (f.search.trim() ? 1 : 0) +
  (f.group !== null ? 1 : 0) +
  (f.exchange !== null ? 1 : 0) +
  (f.priceMin !== null ? 1 : 0) +
  (f.priceMax !== null ? 1 : 0) +
  (f.chgMin !== null ? 1 : 0) +
  (f.chgMax !== null ? 1 : 0) +
  (f.volMin !== null ? 1 : 0) +
  (f.volMax !== null ? 1 : 0) +
  (f.capMin !== null ? 1 : 0);

type ChipKey =
  | 'search'
  | 'group'
  | 'exchange'
  | 'priceMin'
  | 'priceMax'
  | 'chgMin'
  | 'chgMax'
  | 'volMin'
  | 'volMax'
  | 'capMin';

/** `[key, label]` of every active filter, in chip order. */
function chips(
  f: ScreenerFilters,
  t: (key: MessageKey, params?: Record<string, string | number>) => string,
): [ChipKey, string][] {
  const out: [ChipKey, string][] = [];
  if (f.search.trim()) out.push(['search', `“${f.search.trim()}”`]);
  if (f.group !== null) out.push(['group', f.group]);
  if (f.exchange !== null) out.push(['exchange', f.exchange]);
  if (f.priceMin !== null) out.push(['priceMin', `${t('scr.priceMin')} ${f.priceMin}`]);
  if (f.priceMax !== null) out.push(['priceMax', `${t('scr.priceMax')} ${f.priceMax}`]);
  if (f.chgMin !== null) out.push(['chgMin', `${t('scr.chgMin')} ${f.chgMin}%`]);
  if (f.chgMax !== null) out.push(['chgMax', `${t('scr.chgMax')} ${f.chgMax}%`]);
  if (f.volMin !== null) out.push(['volMin', `${t('scr.volMin')} ${fmtCompact(f.volMin)}`]);
  if (f.volMax !== null) out.push(['volMax', `${t('scr.volMax')} ${fmtCompact(f.volMax)}`]);
  if (f.capMin !== null) out.push(['capMin', `${t('scr.capChip')} $${f.capMin}B`]);
  return out;
}

function clearChip(f: ScreenerFilters, key: ChipKey): ScreenerFilters {
  switch (key) {
    case 'search':
      return { ...f, search: '' };
    default:
      return { ...f, [key]: null };
  }
}

function clearAll(f: ScreenerFilters): ScreenerFilters {
  return {
    ...f,
    search: '',
    group: null,
    exchange: null,
    priceMin: null,
    priceMax: null,
    chgMin: null,
    chgMax: null,
    volMin: null,
    volMax: null,
    capMin: null,
  };
}
