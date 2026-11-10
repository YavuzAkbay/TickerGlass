import { memo, type KeyboardEvent } from 'react';
import { commands } from '../commands/registry';
import { useT } from '../i18n';
import type { LiveQuote } from '../quotes/types';
import { changeClass, fmtAuto, fmtSigned } from '../sidebar/format';
import { useLongPress } from '../ui/useLongPress';
import { liveChange, liveLast, formatMetric, type HotlistKind, type HotlistRow } from './kinds';
import { hotlistRowMenu } from './menu';

interface RowProps {
  row: HotlistRow;
  kind: HotlistKind;
  quote: LiveQuote | undefined;
  current: boolean;
}

/** One ranked symbol: ticker (and name), live last, live change, the kind's metric. */
const Row = memo(function Row({ row, kind, quote, current }: RowProps) {
  const t = useT();
  const press = useLongPress((x, y) => hotlistRowMenu(row.symbol, x, y, t));
  const chg = liveChange(row, quote);
  return (
    <li role="presentation">
      <button
        type="button"
        className={`hl-row${current ? ' current' : ''}`}
        data-testid={`hl-row-${row.symbol}`}
        aria-current={current ? 'true' : undefined}
        title={row.name}
        onClick={() => commands.execute('chart.setSymbol', row.symbol)}
        onContextMenu={(e) => {
          e.preventDefault();
          hotlistRowMenu(row.symbol, e.clientX, e.clientY, t);
        }}
        {...press}
      >
        <span className="hl-sym">
          <span className="hl-sym-text">{row.symbol}</span>
          <span className="hl-name">{row.name}</span>
        </span>
        <span className="hl-num rs-num" data-testid={`hl-last-${row.symbol}`}>
          {fmtAuto(liveLast(row, quote))}
        </span>
        <span className={`hl-num rs-num ${changeClass(chg)}`} data-testid={`hl-chg-${row.symbol}`}>
          {fmtSigned(chg, 2, '%')}
        </span>
        <span className="hl-num hl-metric rs-num" data-testid={`hl-metric-${row.symbol}`}>
          {formatMetric(kind, row.value)}
        </span>
      </button>
    </li>
  );
});

/** Arrow keys / Home / End move focus between rows. */
function onListKey(e: KeyboardEvent<HTMLUListElement>) {
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('.hl-row')];
  if (!rows.length) return;
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? rows.length - 1
        : e.key === 'ArrowDown'
          ? Math.min(rows.length - 1, at + 1)
          : Math.max(0, at < 0 ? 0 : at - 1);
  e.preventDefault();
  rows[next]?.focus();
}

interface Props {
  rows: readonly HotlistRow[];
  kind: HotlistKind;
  quotes: Record<string, LiveQuote | undefined>;
  chartSymbol: string;
  label: string;
}

export function HotlistRows({ rows, kind, quotes, chartSymbol, label }: Props) {
  return (
    <ul className="hl-list" aria-label={label} onKeyDown={onListKey}>
      {rows.map((r) => (
        <Row
          key={r.symbol}
          row={r}
          kind={kind}
          quote={quotes[r.symbol]}
          current={r.symbol === chartSymbol}
        />
      ))}
    </ul>
  );
}
