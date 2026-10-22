import { useEffect, useState } from 'react';
import { commands } from '../commands/registry';
import { resolveTimezone, TIMEZONES, utcOffsetLabel } from '../bottombar/timezones';
import { useChartStore } from '../store/chart';
import { useChartView } from '../store/chartView';
import { DropdownMenu, type MenuItem } from '../ui/Menu';

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Chart clock; a click picks the chart's time zone. */
function Clock() {
  const now = useNow();
  const timezone = useChartView((s) => s.timezone);
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
      onSelect: () => useChartView.getState().set({ timezone: z.id }),
    };
  });
  return (
    <>
      <button
        type="button"
        className="sh-pill sh-clock"
        aria-label={`Time zone: ${tz}`}
        data-tip="Time zone"
        data-tip-side="bottom"
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      >
        {time} <span className="sh-pill-muted">{utcOffsetLabel(tz, now)}</span>
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

/** Regular / extended hours toggle and the chart clock, at the right end of the symbol header. */
export function SessionClock() {
  const prepost = useChartView((s) => s.prepost);
  return (
    <div className="sh-session">
      <button
        type="button"
        className={`sh-pill${prepost ? ' active' : ''}`}
        aria-pressed={prepost}
        data-tip={
          prepost
            ? 'Extended trading hours (click for regular)'
            : 'Regular trading hours (click for extended)'
        }
        data-tip-side="bottom"
        onClick={() => commands.execute('session.toggle')}
      >
        {prepost ? 'ETH' : 'RTH'}
      </button>
      <Clock />
    </div>
  );
}
