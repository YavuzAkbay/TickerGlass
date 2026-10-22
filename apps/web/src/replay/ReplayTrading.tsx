import {
  changeClass,
  decimalsForTick,
  fmtPrice,
  fmtSigned,
  makeDateFormatter,
  resolveTimezone,
} from '../sidebar/format';
import { useReplaySymbolInfo, useReplayView } from './instance';
import { totalPnl, unrealized } from './paper';
import { useTrading } from './trading';

function Row({
  label,
  value,
  cls,
  id,
}: {
  label: string;
  value: string;
  cls?: string;
  id: string;
}) {
  return (
    <div className="rs-kv">
      <span className="rs-kv-label">{label}</span>
      <span className={`rs-kv-value rs-num ${cls ?? ''}`} data-testid={id}>
        {value}
      </span>
    </div>
  );
}

/** Paper trades of the running replay: the chart symbol's position, P&L and the fill list. */
export function ReplayTrading() {
  const paper = useTrading((s) => s.paper);
  const marks = useTrading((s) => s.marks);
  const symbol = useReplayView((s) => s.symbol);
  const interval = useReplayView((s) => s.interval);
  const tzSetting = useReplayView((s) => s.timezone);
  const info = useReplaySymbolInfo();
  const d = decimalsForTick(info?.minTick);
  const fmtTime = makeDateFormatter(
    resolveTimezone(tzSetting, info?.timezone),
    !/[DWM]$/.test(interval),
  );

  const pos = paper.positions[symbol];
  const side = !pos ? 'Flat' : pos.qty > 0 ? `Long ${pos.qty}` : `Short ${-pos.qty}`;
  const open = pos ? unrealized({ ...paper, positions: { [symbol]: pos } }, marks) : 0;
  const total = totalPnl(paper, marks);

  return (
    <div className="rt-panel">
      <Row label="Position" value={side} id="rt-position" />
      <Row label="Average price" value={pos ? fmtPrice(pos.avg, d) : '—'} id="rt-avg" />
      <Row label="Last price" value={fmtPrice(marks[symbol], d)} id="rt-last" />
      <Row
        label="Unrealized P&L"
        value={fmtSigned(open, d)}
        cls={changeClass(open)}
        id="rt-unrealized"
      />
      <Row
        label="Realized P&L"
        value={fmtSigned(paper.realized, d)}
        cls={changeClass(paper.realized)}
        id="rt-realized"
      />
      <Row label="Total P&L" value={fmtSigned(total, d)} cls={changeClass(total)} id="rt-total" />
      <div className="rs-section-title">Trades</div>
      {paper.trades.length === 0 ? (
        <div className="rs-empty-text rs-pad">
          No trades yet. Use Buy and Sell in the replay bar.
        </div>
      ) : (
        <table className="rt-trades" aria-label="Practice trades">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Side</th>
              <th>Qty</th>
              <th>Price</th>
            </tr>
          </thead>
          <tbody>
            {[...paper.trades].reverse().map((t) => (
              <tr key={t.id} className={t.side === 'buy' ? 'up' : 'down'}>
                <td>{t.id}</td>
                <td>{fmtTime.format(t.time * 1000)}</td>
                <td>{t.side === 'buy' ? 'Buy' : 'Sell'}</td>
                <td>{t.qty}</td>
                <td>{fmtPrice(t.price, d)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
