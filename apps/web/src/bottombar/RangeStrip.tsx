import { CalendarSearch } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { useChartStore } from '../store/chart';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { IconButton } from '../ui/IconButton';
import { applyRangePreset, RANGE_PRESETS } from './ranges';
import { resolveTimezone, TIMEZONES, utcOffsetLabel } from './timezones';
import './RangeStrip.css';

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function Clock() {
  const now = useNow();
  const timezone = useAppStore((s) => s.timezone);
  const exchangeTz = useChartStore((s) => s.symbolInfo?.timezone);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const tz = resolveTimezone(timezone, exchangeTz);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(now);
  const items: MenuItem[] = TIMEZONES.map((z) => {
    const zoneTz = resolveTimezone(z.id, exchangeTz);
    const suffix = z.id === 'exchange' ? ` (${exchangeTz ?? 'UTC'})` : '';
    return {
      label: `${z.label}${suffix}  ·  ${utcOffsetLabel(zoneTz, now)}`,
      checked: timezone === z.id,
      onSelect: () => useAppStore.getState().set({ timezone: z.id }),
    };
  });
  return (
    <>
      <button
        type="button"
        className="strip-btn strip-clock"
        data-tip="Time zone"
        data-tip-side="top"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {time} ({utcOffsetLabel(tz, now)})
      </button>
      <DropdownMenu
        anchor={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        items={items}
        placement="bottom-end"
      />
    </>
  );
}

function ScaleToggles() {
  const chart = useChartStore((s) => s.chart);
  const [scale, setScale] = useState({ mode: 'linear', autoScale: true });
  useEffect(() => {
    if (!chart) return;
    const sync = () => {
      const ps = chart.getState().panes[0]?.priceScale;
      if (ps) setScale({ mode: ps.mode, autoScale: ps.autoScale });
    };
    sync();
    return chart.on('stateChange', sync);
  }, [chart]);
  const btn = (label: string, active: boolean, cmd: string, tip: string) => (
    <button
      type="button"
      className={`strip-btn${active ? ' active' : ''}`}
      data-tip={tip}
      data-tip-side="top"
      onClick={() => commands.execute(cmd)}
    >
      {label}
    </button>
  );
  return (
    <>
      {btn('%', scale.mode === 'percent', 'chart.scale.percent', 'Toggle percent scale')}
      {btn('log', scale.mode === 'log', 'chart.scale.log', 'Toggle log scale')}
      {btn('auto', scale.autoScale, 'chart.scale.auto', 'Toggle auto scale')}
    </>
  );
}

/** Slim strip under the time axis: range presets, go to date, scale, session and time zone. */
export function RangeStrip() {
  const interval = useAppStore((s) => s.interval);
  const prepost = useAppStore((s) => s.prepost);
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const chart = useChartStore((s) => s.chart);
  const applying = useRef(false);

  // A manual zoom/scroll or interval change clears the highlighted preset.
  useEffect(() => {
    if (!chart) return;
    return chart.on('visibleRangeChange', () =>
      setActivePreset((p) => (applying.current ? p : null)),
    );
  }, [chart]);

  return (
    <div className="range-strip" role="toolbar" aria-label="Range and time controls">
      <div className="strip-seg" role="group" aria-label="Range presets">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={`strip-seg-btn${activePreset === p.label && interval === p.interval ? ' active' : ''}`}
            data-tip={p.title}
            data-tip-side="top"
            onClick={async () => {
              applying.current = true;
              setActivePreset(p.label);
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
      </div>
      <IconButton
        icon={CalendarSearch}
        label="Go to"
        shortcut="Alt+G"
        tipSide="top"
        size={16}
        className="strip-icon"
        onClick={() => commands.execute('chart.goToDate')}
      />
      <span className="strip-spacer" />
      <ScaleToggles />
      <span className="strip-sep" />
      <button
        type="button"
        className={`strip-btn${prepost ? ' active' : ''}`}
        data-tip={
          prepost
            ? 'Extended trading hours (click for regular)'
            : 'Regular trading hours (click for extended)'
        }
        data-tip-side="top"
        onClick={() => commands.execute('session.toggle')}
      >
        {prepost ? 'ETH' : 'RTH'}
      </button>
      <span className="strip-sep" />
      <Clock />
    </div>
  );
}
