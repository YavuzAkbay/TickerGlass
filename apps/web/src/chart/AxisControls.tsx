import type { Chart } from '@tickerglass/engine';
import { CalendarSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { applyRangePreset, RANGE_PRESETS } from '../bottombar/ranges';
import { commands, formatShortcut } from '../commands/registry';
import { setActiveChart } from '../store/chart';
import { useIsMobile } from '../ui/useMediaQuery';
import type { ChartSession } from './session';
import './axisControls.css';

/** Height of the engine's time axis strip (`TIME_AXIS_HEIGHT` in the engine). */
const TIME_AXIS_H = 28;

/** Price-axis width, followed across resizes and label-width changes. */
function useAxisWidth(chart: Chart): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    let raf = 0;
    const measure = () => setW(Math.max(0, chart.root.clientWidth - chart.paneWidth));
    // The engine lays out on its own resize handling: measure once it has run.
    const sync = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => (raf = requestAnimationFrame(measure)));
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(chart.root);
    const offState = chart.on('stateChange', sync);
    const offView = chart.on('viewChange', sync);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      offState();
      offView();
    };
  }, [chart]);
  return w;
}

/**
 * Range presets (and go to date) on the time axis; they show while the pointer is over
 * the chart. On phones they are a scrollable strip under the chart, always visible.
 */
function RangeChips({ session, mobile }: { session: ChartSession; mobile: boolean }) {
  const { chart, id } = session;
  const interval = useStore(session.view, (s) => s.interval);
  const [active, setActive] = useState<string | null>(null);
  const applying = useRef(false);

  // A manual zoom/scroll or interval change clears the highlighted preset.
  useEffect(
    () => chart.on('visibleRangeChange', () => setActive((p) => (applying.current ? p : null))),
    [chart],
  );

  return (
    <div
      className="ax-ranges"
      style={mobile ? undefined : { bottom: TIME_AXIS_H + 6 }}
      role="group"
      aria-label="Range presets"
    >
      {RANGE_PRESETS.map((p) => (
        <button
          key={p.label}
          type="button"
          className={`ax-chip${active === p.label && interval === p.interval ? ' active' : ''}`}
          data-tip={p.title}
          data-tip-side="top"
          onClick={async () => {
            setActiveChart(id);
            applying.current = true;
            setActive(p.label);
            try {
              await applyRangePreset(p);
            } finally {
              setTimeout(() => (applying.current = false), 100);
            }
          }}
        >
          {p.label}
        </button>
      ))}
      <button
        type="button"
        className="ax-chip ax-chip-icon"
        aria-label="Go to date"
        data-tip={`Go to date  ${formatShortcut('Alt+G')}`}
        data-tip-side="top"
        onClick={() => {
          setActiveChart(id);
          commands.execute('chart.goToDate');
        }}
      >
        <CalendarSearch size={14} />
      </button>
    </div>
  );
}

/** Percent, log and auto toggles in the corner where the price and time axes meet. */
function ScaleCorner({ session, mobile }: { session: ChartSession; mobile: boolean }) {
  const { chart, id } = session;
  const width = useAxisWidth(chart);
  const [scale, setScale] = useState({ mode: 'linear', autoScale: true });
  useEffect(() => {
    const sync = () => {
      const ps = chart.getState().panes[0]?.priceScale;
      if (ps) setScale({ mode: ps.mode, autoScale: ps.autoScale });
    };
    sync();
    return chart.on('stateChange', sync);
  }, [chart]);
  if (width < 40) return null;
  const btn = (label: string, on: boolean, cmd: string, tip: string) => (
    <button
      type="button"
      className={`ax-scale-btn${on ? ' active' : ''}`}
      aria-pressed={on}
      aria-label={tip}
      data-tip={tip}
      data-tip-side="top"
      onClick={() => {
        setActiveChart(id);
        commands.execute(cmd);
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      className="ax-scale"
      style={mobile ? undefined : { width, height: TIME_AXIS_H }}
      role="group"
      aria-label="Price scale"
    >
      {btn('%', scale.mode === 'percent', 'chart.scale.percent', 'Percent scale')}
      {btn('log', scale.mode === 'log', 'chart.scale.log', 'Log scale')}
      {btn('A', scale.autoScale, 'chart.scale.auto', 'Auto scale')}
    </div>
  );
}

/**
 * Chart controls that sit on the axes instead of a bottom bar. On phones they move
 * into a strip below the chart (CSS shrinks the chart host), so they never cover
 * time labels, event markers or the price axis.
 */
export function AxisControls({ session }: { session: ChartSession }) {
  const mobile = useIsMobile();
  return (
    <div className="ax-strip">
      <RangeChips session={session} mobile={mobile} />
      <ScaleCorner session={session} mobile={mobile} />
    </div>
  );
}
