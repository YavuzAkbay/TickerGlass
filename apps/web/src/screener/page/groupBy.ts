import type { MessageKey } from '../../i18n';
import type { LiveQuote } from '../../quotes/types';
import { aggregate, type GroupAggregate } from '../../heatmap/grouping';
import type { ScreenerGroupBy } from '../screenerPrefs';
import type { ScanRow } from '../server/types';
import type { Universe, UniverseSymbol } from '../universe/types';

/** Label shown for rows whose group value is missing. */
export const NO_GROUP = '';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The group label of a row. Client mode groups by the universe's own group (sector / category /
 * group); server mode by the snapshot `sector` field, or by the universe group.
 */
export function groupKeyOf(
  by: ScreenerGroupBy,
  s: Pick<UniverseSymbol, 'group'>,
  row: Pick<ScanRow, 'values'> | undefined,
): string {
  if (by === 'sector' && row) {
    const sector = row.values.sector;
    if (typeof sector === 'string' && sector) return sector;
  }
  return s.group || NO_GROUP;
}

/** The group-by choices a table offers: the server knows sectors, the client only the universe group. */
export function groupByChoices(server: boolean): readonly ScreenerGroupBy[] {
  return server ? ['none', 'sector', 'group'] : ['none', 'group'];
}

/** i18n label of a choice (the client's `group` is the class's own: Sector, Category or Group). */
export function groupByLabelKey(
  by: ScreenerGroupBy,
  universe: Pick<Universe, 'groupLabel'>,
  server: boolean,
): MessageKey {
  if (by === 'none') return 'hm.group.none';
  if (by === 'sector') return 'hm.group.sector';
  if (server) return 'hm.group.group';
  return universe.groupLabel === 'sector'
    ? 'hm.group.sector'
    : universe.groupLabel === 'category'
      ? 'hm.group.category'
      : 'hm.group.group';
}

/** A preference from the other engine (client has no `sector` choice) shows as the closest choice. */
export function effectiveGroupBy(by: ScreenerGroupBy, server: boolean): ScreenerGroupBy {
  return groupByChoices(server).includes(by) ? by : by === 'none' ? 'none' : 'group';
}

/** Day change % of a row: the live quote first, the snapshot's `chg1d` otherwise. */
export function rowChange(
  q: LiveQuote | undefined,
  row: Pick<ScanRow, 'values'> | undefined,
): number | null {
  return num(q?.changePercent) ?? num(row?.values.chg1d);
}

/** Market cap (or fund AUM) of a row in USD: live quote, snapshot `mcap`, static universe cap. */
export function rowCap(
  s: Pick<UniverseSymbol, 'cap'>,
  q: LiveQuote | undefined,
  row: Pick<ScanRow, 'values'> | undefined,
): number | null {
  const live = num(q?.marketCap);
  if (live !== null && live > 0) return live;
  const snap = num(row?.values.mcap);
  if (snap !== null && snap > 0) return snap;
  return typeof s.cap === 'number' && s.cap > 0 ? s.cap * 1e9 : null;
}

/** Aggregate of a group's rows (count, mean change %, total cap). */
export function aggregateRows(
  rows: readonly UniverseSymbol[],
  quotes: Readonly<Record<string, LiveQuote | undefined>>,
  snap: Readonly<Record<string, Pick<ScanRow, 'values'> | undefined>> | undefined,
): GroupAggregate {
  return aggregate(
    rows.map((s) => ({
      change: rowChange(quotes[s.symbol], snap?.[s.symbol]),
      cap: rowCap(s, quotes[s.symbol], snap?.[s.symbol]),
    })),
  );
}
