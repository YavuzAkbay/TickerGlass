import { useMemo } from 'react';
import { useT } from '../i18n';
import type { LiveQuote } from '../quotes/types';
import {
  effectiveGroupBy,
  groupByChoices,
  groupByLabelKey,
  groupKeyOf,
} from '../screener/page/groupBy';
import type { ScreenerGroupBy } from '../screener/screenerPrefs';
import type { ScanRow } from '../screener/server/types';
import type { Universe, UniverseSymbol } from '../screener/universe/types';
import { useChartView } from '../store/chartView';
import { GroupSelect } from './GroupSelect';
import { HeatmapPanel } from './HeatmapPanel';
import { HEATMAP_LIVE_CAP, type HeatSymbol } from './metrics';

/** Snapshot fields the heatmap reads from a server scan (merged into the request's `fields`). */
export const HEATMAP_SCAN_FIELDS: readonly string[] = [
  'last',
  'chg1d',
  'volume',
  'mcap',
  'sector',
  'group',
  'perf1w',
  'perf1m',
  'perfYtd',
  'relVol',
  'rsi14',
  'avgDollarVol30',
];

/** The tiles that get live quotes: the biggest by snapshot / static market cap, at most the cap. */
export function liveHeatmapSymbols(
  rows: readonly UniverseSymbol[],
  snap: Readonly<Record<string, Pick<ScanRow, 'values'> | undefined>> | undefined,
  cap: number = HEATMAP_LIVE_CAP,
): string[] {
  if (rows.length <= cap) return rows.map((r) => r.symbol);
  const size = (s: UniverseSymbol): number => {
    const m = snap?.[s.symbol]?.values.mcap;
    return typeof m === 'number' && m > 0 ? m : typeof s.cap === 'number' ? s.cap * 1e9 : -1;
  };
  return rows
    .map((s, i) => ({ symbol: s.symbol, size: size(s), i }))
    .sort((a, b) => b.size - a.size || a.i - b.i)
    .slice(0, cap)
    .map((e) => e.symbol);
}

interface Props {
  universe: Universe;
  /** Results to draw (server: the scan's rows, up to 500; client: the filtered set). */
  rows: readonly UniverseSymbol[];
  quotes: Readonly<Record<string, LiveQuote | undefined>>;
  /** Server mode: snapshot values by symbol. */
  snap?: Readonly<Record<string, ScanRow | undefined>> | undefined;
  groupBy: ScreenerGroupBy;
  onGroupBy: (by: ScreenerGroupBy) => void;
  focus: string | null;
  onFocus: (symbol: string | null) => void;
  onOpen: (symbol: string) => void;
  onMenu: (symbol: string, x: number, y: number) => void;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** More matches than tiles (server cap). */
  total?: number;
  /** Quotes are subscribed for the largest tiles only. */
  liveCount: number;
}

/** The screener's results as a heatmap (both engines). */
export function ScreenerHeatmap({
  universe,
  rows,
  quotes,
  snap,
  groupBy,
  onGroupBy,
  focus,
  onFocus,
  onOpen,
  onMenu,
  loading,
  error = null,
  onRetry,
  total,
  liveCount,
}: Props) {
  const t = useT();
  const server = snap !== undefined;
  const by = effectiveGroupBy(groupBy, server);
  const chartSymbol = useChartView((s) => s.symbol);
  const symbols = useMemo<HeatSymbol[]>(
    () =>
      rows.map((s) => {
        const row = snap?.[s.symbol];
        return {
          symbol: s.symbol,
          name: s.name,
          group: by === 'none' ? '' : groupKeyOf(by, s, row),
          cap: typeof s.cap === 'number' && s.cap > 0 ? s.cap * 1e9 : null,
          snap: row?.values,
        };
      }),
    [rows, snap, by],
  );
  const notes = [
    total !== undefined && total > rows.length
      ? t('hm.truncated', { shown: rows.length, total })
      : null,
    liveCount < rows.length ? t('hm.liveCap', { n: liveCount }) : null,
  ].filter((n): n is string => n !== null);

  return (
    <HeatmapPanel
      symbols={symbols}
      quotes={quotes}
      grouped={by !== 'none'}
      leading={
        <GroupSelect
          testId="hm-group"
          value={by}
          options={groupByChoices(server).map((g) => ({
            value: g,
            label: t(groupByLabelKey(g, universe, server)),
          }))}
          onChange={onGroupBy}
        />
      }
      focus={focus}
      onFocus={onFocus}
      onOpen={onOpen}
      onMenu={onMenu}
      current={chartSymbol}
      loading={loading}
      error={error}
      {...(onRetry ? { onRetry } : {})}
      emptyTitle={t('scr.noMatchTitle')}
      emptyText={t('scr.noMatchText')}
      note={notes.length ? notes.join(' · ') : null}
      ariaLabel={t('hm.screenerLabel')}
    />
  );
}
