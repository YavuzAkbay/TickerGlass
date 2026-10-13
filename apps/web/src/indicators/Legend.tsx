import { getIndicator, type InstanceStatus } from '@investopen/indicators';
import { Database, Ellipsis, Eye, EyeOff, Settings, X } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useChartStore } from '../store/chart';
import { openContextMenu } from '../ui/ContextMenu';
import { DropdownMenu } from '../ui/Menu';
import { removeIndicator, toggleIndicatorVisible } from './actions';
import type { ChartHost } from './controller';
import { inputsTitle, sourceInputKey, type IndicatorState } from './model';
import { indicatorMenuItems, openIndicatorSettings, sourceMenuItems } from './menu';
import { useEffectiveInstances, useIndicatorRuntime } from './store';
import './indicators.css';

/**
 * Legend rows sit inside the chart root, whose native listeners would start a
 * pan or open the chart menu. Handle double-click (settings) and right-click
 * (study menu) here natively and keep the events away from the chart.
 */
function shieldFromChart(el: HTMLDivElement | null) {
  if (!el) return;
  const rowId = (e: Event) =>
    (e.target as HTMLElement).closest<HTMLElement>('[data-indicator-id]')?.dataset.indicatorId;
  const stop = (e: Event) => e.stopPropagation();
  const dbl = (e: MouseEvent) => {
    e.stopPropagation();
    const id = rowId(e);
    if (id && !(e.target as HTMLElement).closest('button')) openIndicatorSettings(id);
  };
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const id = rowId(e);
    if (id) openContextMenu(e.clientX, e.clientY, indicatorMenuItems(id));
  };
  el.addEventListener('pointerdown', stop);
  el.addEventListener('dblclick', dbl);
  el.addEventListener('contextmenu', menu);
  return () => {
    el.removeEventListener('pointerdown', stop);
    el.removeEventListener('dblclick', dbl);
    el.removeEventListener('contextmenu', menu);
  };
}

type LegendChart = Pick<ChartHost, 'getLegendSlot' | 'getStudyValues' | 'store'>;

/** Study legend rows, rendered into each pane's engine legend slot. */
export function IndicatorLegends({ chart }: { chart: LegendChart | null }) {
  const instances = useEffectiveInstances();
  const status = useIndicatorRuntime((s) => s.status);
  const panes = useIndicatorRuntime((s) => s.panes);
  // Re-read last-bar values when results arrive.
  useIndicatorRuntime((s) => s.tick);
  const crossIndex = useChartStore((s) => s.crosshair?.index ?? null);
  if (!chart) return null;
  const index = crossIndex ?? chart.store.length - 1;
  const byPane = new Map<string, IndicatorState[]>();
  for (const inst of instances) {
    const pane = panes[inst.id];
    if (!pane) continue;
    byPane.set(pane, [...(byPane.get(pane) ?? []), inst]);
  }
  return (
    <>
      {[...byPane].map(([paneId, list]) => {
        const slot = chart.getLegendSlot(paneId);
        if (!slot) return null;
        return createPortal(
          <div className="ind-legend" ref={shieldFromChart}>
            {list.map((inst) => (
              <LegendRow
                key={inst.id}
                chart={chart}
                inst={inst}
                all={instances}
                index={index}
                status={status[inst.id]}
              />
            ))}
          </div>,
          slot,
          paneId,
        );
      })}
    </>
  );
}

function LegendRow({
  chart,
  inst,
  all,
  index,
  status,
}: {
  chart: LegendChart;
  inst: IndicatorState;
  all: IndicatorState[];
  index: number;
  status: InstanceStatus | undefined;
}) {
  const [moreBtn, setMoreBtn] = useState<HTMLButtonElement | null>(null);
  const [srcBtn, setSrcBtn] = useState<HTMLButtonElement | null>(null);
  const [menu, setMenu] = useState<'more' | 'source' | null>(null);
  const def = getIndicator(inst.type);
  const name = def?.shortName ?? inst.type;
  const inputs = def ? inputsTitle(def, inst.inputs, (id) => all.find((i) => i.id === id)) : '';
  const hasSource = !!def && !!sourceInputKey(def);
  const values =
    inst.visible && status?.state === 'ok' && index >= 0
      ? chart.getStudyValues(inst.id, index)
      : [];

  let tail;
  if (!def || status?.state === 'error') {
    const msg = def ? (status?.state === 'error' ? status.message : '') : 'Unknown indicator';
    tail = (
      <span className="ind-legend-error" title={msg}>
        {msg}
      </span>
    );
  } else if (status?.state === 'waiting') {
    tail = <span className="ind-legend-muted">Loading {status.timeframe}…</span>;
  } else {
    tail = values.map((v) => (
      <span
        key={v.outputId}
        className="ind-legend-value"
        style={{ color: v.color }}
        title={v.title}
      >
        {v.text || '∅'}
      </span>
    ));
  }

  return (
    <div
      className={`ind-legend-row${inst.visible ? '' : ' off'}${menu ? ' menu-open' : ''}`}
      data-indicator-id={inst.id}
    >
      <span className="ind-legend-name">{name}</span>
      {inputs ? <span className="ind-legend-inputs">{inputs}</span> : null}
      <span className="ind-legend-actions">
        <button
          type="button"
          className="ind-legend-btn"
          aria-label={inst.visible ? 'Hide' : 'Show'}
          title={inst.visible ? 'Hide' : 'Show'}
          onClick={() => toggleIndicatorVisible(inst.id)}
        >
          {inst.visible ? <Eye size={15} /> : <EyeOff size={15} />}
        </button>
        <button
          type="button"
          className="ind-legend-btn"
          aria-label="Settings"
          title="Settings"
          onClick={() => openIndicatorSettings(inst.id)}
        >
          <Settings size={15} />
        </button>
        {hasSource ? (
          <button
            ref={setSrcBtn}
            type="button"
            className="ind-legend-btn"
            aria-label="Source"
            title="Source"
            aria-haspopup="menu"
            aria-expanded={menu === 'source'}
            onClick={() => setMenu((m) => (m === 'source' ? null : 'source'))}
          >
            <Database size={15} />
          </button>
        ) : null}
        <button
          type="button"
          className="ind-legend-btn"
          aria-label="Remove"
          title="Remove"
          onClick={() => removeIndicator(inst.id)}
        >
          <X size={15} />
        </button>
        <button
          ref={setMoreBtn}
          type="button"
          className="ind-legend-btn"
          aria-label="More"
          title="More"
          aria-haspopup="menu"
          aria-expanded={menu === 'more'}
          onClick={() => setMenu((m) => (m === 'more' ? null : 'more'))}
        >
          <Ellipsis size={15} />
        </button>
      </span>
      {inst.visible ? tail : null}
      <DropdownMenu
        anchor={moreBtn}
        open={menu === 'more'}
        onClose={() => setMenu(null)}
        items={menu === 'more' ? indicatorMenuItems(inst.id) : []}
      />
      <DropdownMenu
        anchor={srcBtn}
        open={menu === 'source'}
        onClose={() => setMenu(null)}
        items={menu === 'source' ? sourceMenuItems(inst.id) : []}
      />
    </div>
  );
}
