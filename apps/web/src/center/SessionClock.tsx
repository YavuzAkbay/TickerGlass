import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { resolveTimezone, TIMEZONES, utcOffsetLabel } from '../bottombar/timezones';
import type { ChartSession } from '../chart/session';
import { commands } from '../commands/registry';
import { setActiveChart } from '../store/chart';
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
function Clock({ session }: { session: ChartSession }) {
  const now = useNow();
  const timezone = useStore(session.view, (s) => s.timezone);
  const exchangeTz = useStore(session.info, (s) => s.symbolInfo?.timezone);
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
      onSelect: () => session.view.getState().set({ timezone: z.id }),
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

/** Regular / extended hours toggle and the chart clock of one chart. */
export function SessionClock({ session }: { session: ChartSession }) {
  const prepost = useStore(session.view, (s) => s.prepost);
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
        onClick={() => {
          setActiveChart(session.id);
          commands.execute('session.toggle');
        }}
      >
        {prepost ? 'ETH' : 'RTH'}
      </button>
      <Clock session={session} />
    </div>
  );
}
