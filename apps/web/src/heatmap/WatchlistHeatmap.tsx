import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useT } from '../i18n';
import { useLiveQuotes } from '../quotes/hooks';
import { useSnapshots } from '../screener/server/snapshot';
import { rowMenu } from '../sidebar/watchlist/rowMenu';
import { useChartView } from '../store/chartView';
import {
  peekSymbolMeta,
  useSymbolMeta,
  useSymbolMetaVersion,
  wantSymbolMetas,
} from '../watchlist/page/symbolMeta';
import type { ListRef, WatchlistItem } from '../watchlist/types';
import { GroupSelect } from './GroupSelect';
import { HeatmapPanel } from './HeatmapPanel';
import { useHeatmapPrefs, WATCHLIST_HEAT_GROUPS, type WatchlistHeatGroup } from './heatmapPrefs';
import { HEATMAP_LIVE_CAP, pickLargest, type HeatSymbol } from './metrics';

/** Names are resolved for small lists up front (one search call each, throttled). */
const EAGER_NAMES = 60;

const GROUP_LABEL = {
  none: 'hm.group.none',
  section: 'hm.group.section',
  sector: 'hm.group.sector',
} as const satisfies Record<WatchlistHeatGroup, string>;

/** Tooltip name: resolves lazily, like the table's Name column. */
function MetaName({ symbol }: { symbol: string }) {
  return <>{useSymbolMeta(symbol)?.name ?? ''}</>;
}

/** One symbol and the title of the section it sits under ('' above the first section). */
export interface WatchlistTile {
  symbol: string;
  section: string;
}

/** Symbols of `items` in list order, each with its section title; repeats are dropped. */
export function tilesOf(items: readonly WatchlistItem[]): WatchlistTile[] {
  const out: WatchlistTile[] = [];
  const seen = new Set<string>();
  let section = '';
  for (const it of items) {
    if (it.type === 'section') section = it.title;
    else if (!seen.has(it.symbol)) {
      seen.add(it.symbol);
      out.push({ symbol: it.symbol, section });
    }
  }
  return out;
}

interface Props {
  listRef: ListRef;
  /** The list's items after the page filter (collapsed sections are ignored on the map). */
  items: readonly WatchlistItem[];
  filter: string;
  onFilterChange: (value: string) => void;
  focus: string | null;
  onFocus: (symbol: string | null) => void;
  onOpen: (symbol: string) => void;
  listEmpty: boolean;
}

/** The watchlists page's heatmap view of the current list. */
export function WatchlistHeatmap({
  listRef,
  items,
  filter,
  onFilterChange,
  focus,
  onFocus,
  onOpen,
  listEmpty,
}: Props) {
  const t = useT();
  const group = useHeatmapPrefs((s) => s.watchlistGroup);
  const chartSymbol = useChartView((s) => s.symbol);
  const filterRef = useRef<HTMLInputElement>(null);
  const metaVersion = useSymbolMetaVersion();

  const tiles = useMemo(() => tilesOf(items), [items]);
  const symbolList = useMemo(() => tiles.map((x) => x.symbol), [tiles]);
  // Sector, market cap, performance and RSI come from the nightly snapshot.
  const snaps = useSnapshots(symbolList);

  useEffect(() => {
    if (symbolList.length > EAGER_NAMES) return;
    wantSymbolMetas('heatmap', symbolList);
    return () => wantSymbolMetas('heatmap', null);
  }, [symbolList]);

  const symbols = useMemo<HeatSymbol[]>(
    () =>
      tiles.map((x) => {
        const snap = snaps[x.symbol.toUpperCase()];
        const sector = typeof snap?.sector === 'string' ? snap.sector : '';
        return {
          symbol: x.symbol,
          name: peekSymbolMeta(x.symbol)?.name ?? '',
          group: group === 'section' ? x.section : group === 'sector' ? sector : '',
          cap: null,
          snap,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- metaVersion tracks name resolution
    [tiles, snaps, group, metaVersion],
  );

  // Live quotes for the largest tiles only; the rest show their snapshot values.
  const live = useMemo(
    () =>
      pickLargest(
        symbols,
        (s) => (typeof s.snap?.mcap === 'number' ? s.snap.mcap : null),
        HEATMAP_LIVE_CAP,
      ),
    [symbols],
  );
  const quotes = useLiveQuotes(live);

  const empty = listEmpty
    ? { title: t('wlp.emptyTitle'), text: t('wlp.emptyText') }
    : { title: t('wlp.noMatchTitle'), text: t('wlp.noMatchText', { filter: filter.trim() }) };

  return (
    <div className="wlp-table">
      <HeatmapPanel
        symbols={symbols}
        quotes={quotes}
        grouped={group !== 'none'}
        leading={
          <>
            <div className="wlp-filter">
              <Search size={13} aria-hidden="true" />
              <input
                ref={filterRef}
                value={filter}
                onChange={(e) => onFilterChange(e.target.value)}
                placeholder={t('wlp.filter')}
                aria-label={t('wlp.filter')}
                spellCheck={false}
                data-testid="wlp-filter"
              />
              {filter ? (
                <button
                  type="button"
                  className="wlp-filter-clear"
                  aria-label={t('wlp.clearFilter')}
                  onClick={() => {
                    onFilterChange('');
                    filterRef.current?.focus();
                  }}
                >
                  <X size={12} />
                </button>
              ) : null}
            </div>
            <GroupSelect
              testId="hm-group"
              value={group}
              options={WATCHLIST_HEAT_GROUPS.map((g) => ({ value: g, label: t(GROUP_LABEL[g]) }))}
              onChange={(g) => useHeatmapPrefs.getState().setWatchlistGroup(g)}
            />
          </>
        }
        focus={focus}
        onFocus={onFocus}
        onOpen={onOpen}
        onMenu={(symbol, x, y) => rowMenu(symbol, listRef, x, y, { onOpen })}
        current={chartSymbol}
        emptyTitle={empty.title}
        emptyText={empty.text}
        note={symbols.length > live.length ? t('hm.liveCap', { n: live.length }) : null}
        nameNode={(symbol) => <MetaName symbol={symbol} />}
        ariaLabel={t('hm.watchlistLabel')}
      />
    </div>
  );
}
