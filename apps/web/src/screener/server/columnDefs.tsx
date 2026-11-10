import { changeClass, fmtCap, fmtCompact, fmtPrice, fmtSigned, isNum } from '../../sidebar/format';
import { scrColumns, type ScrCellCtx, type ScrColumnDef } from '../page/pageColumns';
import type { Universe as ClassUniverse } from '../universe/types';
import { formulaOfColumn, SERVER_ALL_COLUMNS, type FormulaColumnId } from './columns';
import type { ScanRow } from './types';

/** What a server-table cell sees: the page row's snapshot values next to the live quote. */
export interface ServerCellCtx extends ScrCellCtx {
  row?: ScanRow | undefined;
}

export interface ServerColumnDef extends Omit<ScrColumnDef, 'id' | 'render'> {
  id: string;
  render: (ctx: ServerCellCtx) => ReturnType<ScrColumnDef['render']>;
}

const num = (row: ScanRow | undefined, f: string): number | null => {
  const v = row?.values[f];
  return isNum(v as number | null | undefined) ? (v as number) : null;
};

const signedPct = (v: number | null) => ({
  text: v === null ? '' : fmtSigned(v, 2, '%'),
  className: changeClass(v),
});

const col = (
  id: string,
  label: string,
  title: string,
  width: string,
  render: ServerColumnDef['render'],
  align: 'left' | 'right' = 'right',
): ServerColumnDef => ({ id, label, title, width, align, render, sortable: true });

/** Display text of a unix-seconds date. */
export const dayText = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

/**
 * Column catalog of the server table. The quote columns prefer the live quote and fall back
 * to the snapshot value (`last`, `chg1d`, `volume`) until the first tick arrives.
 */
export function serverColumnDefs(universe: ClassUniverse): Record<string, ServerColumnDef> {
  const base = scrColumns(universe);
  const out: Record<string, ServerColumnDef> = {};
  for (const id of SERVER_ALL_COLUMNS) {
    const b = (base as Record<string, ScrColumnDef | undefined>)[id];
    if (b) out[id] = b;
  }
  out.last = {
    ...base.last,
    render: (ctx) => {
      if (isNum(ctx.q?.last)) return base.last.render(ctx);
      const v = num(ctx.row, 'last');
      return { text: v === null ? '' : fmtPrice(v) };
    },
  };
  out.changePercent = {
    ...base.changePercent,
    render: (ctx) =>
      isNum(ctx.q?.changePercent)
        ? base.changePercent.render(ctx)
        : signedPct(num(ctx.row, 'chg1d')),
  };
  out.volume = {
    ...base.volume,
    render: (ctx) => {
      if (isNum(ctx.q?.volume)) return base.volume.render(ctx);
      const v = num(ctx.row, 'volume');
      return { text: v === null ? '' : fmtCompact(v) };
    },
  };
  out.relVol = col(
    'relVol',
    'Rel vol',
    'Relative volume (snapshot)',
    'minmax(58px, 0.8fr)',
    ({ row }) => {
      const v = num(row, 'relVol');
      return { text: v === null ? '' : `${v.toFixed(v >= 10 ? 0 : 1)}×` };
    },
  );
  const perf = (id: string, label: string, title: string) =>
    col(id, label, title, 'minmax(60px, 0.8fr)', ({ row }) => signedPct(num(row, id)));
  out.perf1w = perf('perf1w', '1W', 'Performance, 1 week');
  out.perf1m = perf('perf1m', '1M', 'Performance, 1 month');
  out.perfYtd = perf('perfYtd', 'YTD', 'Performance, year to date');
  out.perf1y = perf('perf1y', '1Y', 'Performance, 1 year');
  out.rsi14 = col('rsi14', 'RSI', 'RSI (14)', 'minmax(50px, 0.7fr)', ({ row }) => {
    const v = num(row, 'rsi14');
    return {
      text: v === null ? '' : v.toFixed(1),
      className: v !== null && v >= 70 ? 'up' : v !== null && v <= 30 ? 'down' : '',
    };
  });
  out.pctVsSma200 = col(
    'pctVsSma200',
    'vs SMA200',
    'Distance from the 200-day average',
    'minmax(66px, 0.9fr)',
    ({ row }) => signedPct(num(row, 'pctVsSma200')),
  );
  out.atrPct = col(
    'atrPct',
    'ATR%',
    'Average true range (14) as % of price',
    'minmax(54px, 0.7fr)',
    ({ row }) => {
      const v = num(row, 'atrPct');
      return { text: v === null ? '' : `${v.toFixed(2)}%` };
    },
  );
  out.pctOffHi52 = col(
    'pctOffHi52',
    'Off 52W hi',
    'Distance below the 52-week high',
    'minmax(66px, 0.9fr)',
    ({ row }) => signedPct(num(row, 'pctOffHi52')),
  );
  out.mcap = col('mcap', 'Mkt cap', 'Market cap (snapshot)', 'minmax(64px, 0.9fr)', ({ row }) => {
    const v = num(row, 'mcap');
    return { text: v === null ? '' : fmtCap(v), className: 'scr-cap' };
  });
  out.pe = col('pe', 'P/E', 'Trailing P/E', 'minmax(48px, 0.6fr)', ({ row }) => {
    const v = num(row, 'pe');
    return { text: v === null ? '' : v.toFixed(1) };
  });
  out.divYield = col('divYield', 'Div %', 'Dividend yield', 'minmax(52px, 0.7fr)', ({ row }) => {
    const v = num(row, 'divYield');
    return { text: v === null ? '' : `${v.toFixed(2)}%` };
  });
  out.nextEarnings = col(
    'nextEarnings',
    'Earnings',
    'Next earnings date',
    'minmax(78px, 1fr)',
    ({ row }) => {
      const v = num(row, 'nextEarnings');
      return { text: v === null ? '' : dayText(v) };
    },
  );
  out.daysToEarnings = col(
    'daysToEarnings',
    'Days to ER',
    'Days until the next earnings',
    'minmax(60px, 0.8fr)',
    ({ row }) => {
      const v = num(row, 'daysToEarnings');
      return { text: v === null ? '' : `${Math.round(v)}d` };
    },
  );
  out.sector = col(
    'sector',
    'Sector',
    'Sector',
    'minmax(84px, 1fr)',
    ({ row }) => {
      const v = row?.values.sector;
      return { text: typeof v === 'string' ? v : '', className: 'scr-static' };
    },
    'left',
  );
  return out;
}

/** Display text of a formula value: compact beyond a million, else up to 4 decimals. */
export function formulaText(v: number | null): string {
  if (v === null) return '';
  if (Math.abs(v) >= 1e6) return fmtCompact(v);
  return String(Number(v.toFixed(Math.abs(v) >= 100 ? 2 : 4)));
}

/**
 * A formula column (`"=<formula>"`): the scan's value under the same key, numeric. Not
 * sortable: the server sorts by field ids only, and sorting one page client-side would
 * disagree with the pager.
 */
export function formulaColumnDef(id: FormulaColumnId, label: string): ServerColumnDef {
  return {
    ...col(id, label, `${label} = ${formulaOfColumn(id)}`, 'minmax(70px, 0.9fr)', ({ row }) => ({
      text: formulaText(num(row, id)),
    })),
    sortable: false,
  };
}
