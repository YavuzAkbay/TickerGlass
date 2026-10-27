/**
 * Chart data export: builds the export table from a chart (displayed OHLCV
 * plus every attached study's plot columns) and serializes it to CSV. Pure
 * data, no DOM — the XLSX writer (xlsx.ts) and the tests build on the same
 * table. Everything is generated in the browser; the server is not involved.
 */
import { isIntraday, parseInterval, type Chart } from '@tickerglass/engine';
import { DEFAULT_VOLUME_ID } from '../indicators/model';
import { utcStamp } from './screenshot';

/** One data column after `time`; values are aligned to the displayed series. */
export interface ExportColumn {
  header: string;
  values: Float64Array;
  /** Valid value indices are [0, length); arrays may have spare capacity. */
  length: number;
  /** Plots with an offset draw value[i - offset] at displayed bar i. */
  offset: number;
}

/** Columnar export table: row i is the displayed bar i. */
export interface ExportTable {
  n: number;
  time: Float64Array;
  columns: ExportColumn[];
}

/** Chart-independent input for buildTable (so tests need no engine Chart). */
export interface ExportStudyInput {
  title: string;
  plots: { id: string; title: string; offset: number }[];
  values: Record<string, Float64Array>;
  length: number;
}

export interface ExportInput {
  time: Float64Array;
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
  volume: Float64Array;
  studies: ExportStudyInput[];
}

/**
 * Snapshot the chart's displayed series and attached studies. Returns null
 * when the chart has no bars. The built-in volume study is skipped (volume is
 * already a column) and studies without current data (e.g. mid-load) are left
 * out. Column order follows pane order; studies of one pane keep add order.
 */
export function exportInputFromChart(chart: Chart): ExportInput | null {
  const store = chart.store;
  if (!store.length) return null;
  const paneOrder = new Map(chart.getState().panes.map((p, i) => [p.id, i] as const));
  // getStudies() returns a fresh array, so sorting it is fine; the sort is
  // stable, so studies sharing a pane keep their add order.
  const studies: ExportStudyInput[] = chart
    .getStudies()
    .filter((s) => s.id !== DEFAULT_VOLUME_ID)
    .sort((a, b) => (paneOrder.get(a.paneId) ?? 1e9) - (paneOrder.get(b.paneId) ?? 1e9))
    .flatMap((info) => {
      const data = chart.getStudyData(info.id);
      if (!data || !data.current) return [];
      const plots = data.spec.outputs.flatMap((o) => {
        if (o.type !== 'plot') return [];
        return data.values[o.id] ? [{ id: o.id, title: o.title, offset: o.offset }] : [];
      });
      if (!plots.length) return [];
      return [{ title: data.spec.title, plots, values: data.values, length: data.length }];
    });
  return {
    time: store.time.subarray(0, store.length),
    open: store.open.subarray(0, store.length),
    high: store.high.subarray(0, store.length),
    low: store.low.subarray(0, store.length),
    close: store.close.subarray(0, store.length),
    volume: store.volume.subarray(0, store.length),
    studies,
  };
}

/**
 * Build the export table: `time` plus open/high/low/close/volume, then one
 * column per study plot. Multi-plot studies qualify each header with the
 * output title ("MACD 12 26 9 signal"); duplicates get " (2)" suffixes.
 */
export function buildTable(input: ExportInput): ExportTable {
  const n = input.time.length;
  const columns: ExportColumn[] = (
    [input.open, input.high, input.low, input.close, input.volume] as const
  ).map((values, i) => ({
    header: OHLCV_HEADERS[i]!,
    values,
    length: n,
    offset: 0,
  }));
  for (const study of input.studies)
    for (const plot of study.plots)
      columns.push({
        header: study.plots.length > 1 ? `${study.title} ${plot.title}` : study.title,
        values: study.values[plot.id]!,
        length: study.length,
        offset: plot.offset,
      });
  dedupeHeaders(columns);
  return { n, time: input.time, columns };
}

const OHLCV_HEADERS = ['open', 'high', 'low', 'close', 'volume'] as const;

function dedupeHeaders(columns: ExportColumn[]): void {
  const seen = new Map<string, number>();
  for (const col of columns) {
    const count = seen.get(col.header) ?? 0;
    seen.set(col.header, count + 1);
    if (count > 0) col.header = `${col.header} (${count + 1})`;
  }
}

/** Cell text for a value: shortest round-trip decimal, or '' when there is none. */
export function numberCell(v: number): string {
  return Number.isFinite(v) ? String(v) : '';
}

export type TimeFormatter = (t: number) => string;

/**
 * Bar-time formatter for the chart's display timezone: `YYYY-MM-DD` for
 * day/week/month bars, `YYYY-MM-DD HH:mm` intraday. `tz` is an IANA name,
 * 'UTC' or 'local' (the browser's zone).
 */
export function makeTimeFormatter(tz: string, intraday: boolean): TimeFormatter {
  const zone = tz === 'local' ? undefined : tz;
  const date = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: zone,
  });
  const clock = intraday
    ? new Intl.DateTimeFormat('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone: zone,
      })
    : null;
  return (t) => {
    const d = new Date(t * 1000);
    const dp = date.formatToParts(d);
    const year = dp.find((p) => p.type === 'year')?.value ?? '';
    const month = dp.find((p) => p.type === 'month')?.value ?? '';
    const day = dp.find((p) => p.type === 'day')?.value ?? '';
    if (!clock) return `${year}-${month}-${day}`;
    const cp = clock.formatToParts(d);
    const hour = cp.find((p) => p.type === 'hour')?.value ?? '';
    const minute = cp.find((p) => p.type === 'minute')?.value ?? '';
    return `${year}-${month}-${day} ${hour === '24' ? '00' : hour}:${minute}`;
  };
}

/** RFC 4180 field: quote when it contains a comma, quote or newline. */
export function csvField(text: string): string {
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Field for user-controlled text (study titles): a leading `=`, `+`, `-`, `@`,
 * tab or CR would make a spreadsheet read the cell as a formula, so it gets a
 * `'` prefix (OWASP CSV injection). Never for numeric cells: negative numbers
 * must stay numbers.
 */
export function csvTextField(text: string): string {
  return csvField(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);
}

/** Serialize the table as CSV (LF newlines, no trailing newline). */
export function toCsv(table: ExportTable, fmtTime: TimeFormatter): string {
  const rows: string[] = [
    ['time', ...table.columns.map((c) => c.header)].map(csvTextField).join(','),
  ];
  for (let i = 0; i < table.n; i++) {
    const row: string[] = [fmtTime(table.time[i]!)];
    for (const col of table.columns) {
      const j = i - col.offset;
      row.push(j >= 0 && j < col.length ? numberCell(col.values[j]!) : '');
    }
    rows.push(row.join(','));
  }
  return rows.join('\n');
}

/** `<symbol>_<interval>_<YYYY-MM-DD_HH-mm>.<ext>`, UTC, safe for file systems. */
export function dataFilename(
  symbol: string,
  interval: string,
  ext: 'csv' | 'xlsx',
  date: Date,
): string {
  const safe = (s: string) => s.replace(/[^\w.^=-]+/g, '_');
  const stamp = utcStamp(date).replace(' ', '_').replace(':', '-');
  return `${safe(symbol)}_${safe(interval)}_${stamp}.${ext}`;
}

/** Intraday when the chart's interval is minute/hour based. */
export function isIntradayInterval(interval: string): boolean {
  return isIntraday(parseInterval(interval));
}
