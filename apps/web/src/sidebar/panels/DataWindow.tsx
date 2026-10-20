import { useMemo } from 'react';
import { useChartView } from '../../store/chartView';
import { useChartStore } from '../../store/chart';
import {
  changeClass,
  decimalsForTick,
  fmtAuto,
  fmtCompact,
  fmtPrice,
  fmtSigned,
  isNum,
  makeDateFormatter,
  resolveTimezone,
} from '../format';
import { useChartTick } from '../hooks';

function Row({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="rs-kv">
      <span className="rs-kv-label">{label}</span>
      <span className={`rs-kv-value rs-num ${cls ?? ''}`}>{value}</span>
    </div>
  );
}

/** Values under the crosshair (or for the last bar). */
export function DataWindow() {
  const chart = useChartStore((s) => s.chart);
  const symbolInfo = useChartStore((s) => s.symbolInfo);
  const crosshair = useChartStore((s) => s.crosshair);
  const tzSetting = useChartView((s) => s.timezone);
  const interval = useChartView((s) => s.interval);
  useChartTick(chart, ['dataLoaded', 'stateChange', 'barUpdate']);

  const intraday = !/[DWM]$/.test(interval);
  const tz = resolveTimezone(tzSetting, symbolInfo?.timezone);
  const dateFmt = useMemo(() => makeDateFormatter(tz, intraday), [tz, intraday]);

  if (!chart) return <div className="rs-empty-text rs-pad">No chart</div>;

  const store = chart.store;
  const index = crosshair?.bar && isNum(crosshair.index) ? crosshair.index : store.length - 1;
  const bar = store.bar(index);
  const prev = store.bar(index - 1);
  const d = decimalsForTick(symbolInfo?.minTick);
  const change = bar && prev ? bar.close - prev.close : null;
  const changePct = change !== null && prev && prev.close ? (change / prev.close) * 100 : null;
  const cls = changeClass(change);

  return (
    <div className="rs-datawin">
      <div className="rs-section-title">
        {symbolInfo?.symbol ?? chart.getSymbol()}
        <span className="rs-muted"> · {interval}</span>
      </div>
      <Row label="Date" value={bar ? dateFmt.format(new Date(bar.time * 1000)) : '—'} />
      <Row label="Open" value={fmtPrice(bar?.open, d)} />
      <Row label="High" value={fmtPrice(bar?.high, d)} />
      <Row label="Low" value={fmtPrice(bar?.low, d)} />
      <Row label="Close" value={fmtPrice(bar?.close, d)} cls={cls} />
      <Row label="Change" value={fmtSigned(change, d)} cls={cls} />
      <Row label="Change %" value={fmtSigned(changePct, 2, '%')} cls={cls} />
      <Row label="Volume" value={fmtCompact(bar?.volume)} />
      {chart.panes.map((pane) => {
        const series = pane.series.filter((s) => s.id !== 'main');
        if (!series.length || !bar) return null;
        return (
          <div key={pane.id}>
            <div className="rs-section-title">
              {pane.id === 'main' ? 'Overlays' : series[0]?.title || pane.id}
            </div>
            {series.map((s) => {
              const values = s.valuesAt(index);
              return (
                <Row
                  key={s.id}
                  label={s.title || s.id}
                  value={values.length ? values.map((v) => fmtAuto(v)).join('  ') : '—'}
                />
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
