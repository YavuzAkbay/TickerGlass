import type { LiveQuote } from '../../quotes/types';
import { COLUMNS, type CellValue } from '../../sidebar/watchlist/columns';
import { fmtCompact, fmtPrice, isNum } from '../../sidebar/format';
import type { ScreenerColumnId } from '../screenerPrefs';
import type { Universe, UniverseSymbol } from '../universe/types';
import { effectiveCap, liveCapBillions, relVolume, turnover, type ScreenerSortKey } from '../model';

/** Everything a screener cell needs to render itself. */
export interface ScrCellCtx {
  s: UniverseSymbol;
  q: LiveQuote | undefined;
}

export interface ScrColumnDef {
  id: ScreenerColumnId;
  label: string;
  /** Long name for tooltips and the columns menu. */
  title: string;
  /** Grid track. */
  width: string;
  align: 'left' | 'right';
  /** `dayRange`, `week52Range` and `trend` draw themselves in the row, not here. */
  render: (ctx: ScrCellCtx) => CellValue;
  sortable: boolean;
}

const numCol = (
  id: 'last' | 'change' | 'changePercent' | 'volume',
  width: string,
): ScrColumnDef => {
  const def = COLUMNS[id];
  return {
    id,
    label: def.label,
    title: def.title,
    width,
    align: 'right',
    render: ({ q }) => def.render(q),
    sortable: true,
  };
};

/** Column catalog of the screener table. `dayRange`/`week52Range`/`trend` render in ResultRow. */
export function scrColumns(universe: Universe): Record<ScreenerColumnId, ScrColumnDef> {
  const capTitle =
    universe.capKind === 'mcap'
      ? 'Market cap (approximate)'
      : universe.capKind === 'aum'
        ? 'Fund AUM (approximate)'
        : '';
  return {
    name: {
      id: 'name',
      label: 'Name',
      title: 'Name',
      width: 'minmax(110px, 2.2fr)',
      align: 'left',
      render: ({ s }) => ({ text: s.name, className: 'scr-name' }),
      sortable: true,
    },
    last: numCol('last', 'minmax(64px, 1fr)'),
    change: numCol('change', 'minmax(60px, 0.9fr)'),
    changePercent: numCol('changePercent', 'minmax(64px, 0.9fr)'),
    prevClose: {
      id: 'prevClose',
      label: 'Prev',
      title: 'Previous close',
      width: 'minmax(60px, 0.9fr)',
      align: 'right',
      render: ({ q }) => ({ text: fmtPrice(q?.prevClose) }),
      sortable: true,
    },
    volume: numCol('volume', 'minmax(64px, 0.9fr)'),
    relVolume: {
      id: 'relVolume',
      label: 'Rel vol',
      title: 'Relative volume (volume ÷ average volume)',
      width: 'minmax(58px, 0.8fr)',
      align: 'right',
      render: ({ q }) => {
        const v = relVolume(q);
        return { text: isNum(v) ? `${v.toFixed(v >= 10 ? 0 : 1)}×` : '' };
      },
      sortable: true,
    },
    turnover: {
      id: 'turnover',
      label: 'Turnover',
      title: 'Turnover (volume × last)',
      width: 'minmax(68px, 1fr)',
      align: 'right',
      render: ({ q }) => {
        const v = turnover(q);
        return { text: isNum(v) ? `$${fmtCompact(v)}` : '', className: 'scr-cap' };
      },
      sortable: true,
    },
    dayRange: {
      id: 'dayRange',
      label: 'Range',
      title: 'Day range',
      width: 'minmax(72px, 1.1fr)',
      align: 'right',
      render: () => ({ text: '' }),
      sortable: true,
    },
    week52Range: {
      id: 'week52Range',
      label: '52W range',
      title: '52-week range (low to high, marker at the last price)',
      width: 'minmax(72px, 1.1fr)',
      align: 'right',
      render: () => ({ text: '' }),
      sortable: true,
    },
    extChangePercent: {
      id: 'extChangePercent',
      label: 'Ext%',
      title: 'Pre/post-market change %',
      width: 'minmax(64px, 0.9fr)',
      align: 'right',
      render: ({ q }) => COLUMNS.extChangePercent.render(q),
      sortable: true,
    },
    cap: {
      id: 'cap',
      label: 'Cap',
      title: capTitle,
      width: 'minmax(60px, 0.9fr)',
      align: 'right',
      render: ({ s }) => ({
        text: isNum(s.cap) ? `$${fmtCompact(s.cap * 1e9)}` : '',
        className: 'scr-cap',
      }),
      sortable: true,
    },
    liveCap: {
      id: 'liveCap',
      label: 'Mkt cap',
      title:
        universe.capKind === 'aum'
          ? 'Fund AUM (approximate)'
          : 'Market cap (live when the quote carries it, else the static snapshot, marked ~)',
      width: 'minmax(64px, 0.9fr)',
      align: 'right',
      render: ({ s, q }) => {
        const cap = effectiveCap(s, q, universe.capKind);
        if (!isNum(cap)) return { text: '', className: 'scr-cap' };
        const stale = universe.capKind !== 'mcap' || liveCapBillions(q) === null;
        return { text: `${stale ? '~' : ''}$${fmtCompact(cap * 1e9)}`, className: 'scr-cap' };
      },
      sortable: true,
    },
    group: {
      id: 'group',
      label: 'Group',
      title: 'Sector / category / group',
      width: 'minmax(84px, 1fr)',
      align: 'left',
      render: ({ s }) => ({ text: s.group, className: 'scr-static' }),
      sortable: true,
    },
    exchange: {
      id: 'exchange',
      label: 'Exch',
      title: 'Exchange / venue',
      width: 'minmax(70px, 0.8fr)',
      align: 'left',
      render: ({ s }) => ({ text: s.exchange ?? '', className: 'scr-static' }),
      sortable: true,
    },
    trend: {
      id: 'trend',
      label: 'Trend',
      title: '30-day trend',
      width: '96px',
      align: 'right',
      render: () => ({ text: '' }),
      sortable: false,
    },
  };
}

/** Sort key of a column header (`rank` = not sortable; the trend sparkline). */
export function columnSortKey(id: ScreenerColumnId): ScreenerSortKey {
  switch (id) {
    case 'dayRange':
      return 'dayRangePct';
    case 'week52Range':
      return 'week52Pos';
    case 'trend':
      return 'rank';
    default:
      return id;
  }
}

/** Sortable screener keys (the table header only offers these). */
export const SCR_SORT_KEYS: readonly ScreenerSortKey[] = [
  'symbol',
  'name',
  'group',
  'exchange',
  'cap',
  'liveCap',
  'last',
  'change',
  'changePercent',
  'prevClose',
  'volume',
  'relVolume',
  'turnover',
  'extChangePercent',
  'dayRangePct',
  'week52Pos',
];
