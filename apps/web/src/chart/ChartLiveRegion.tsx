import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { fmtAuto, makeDateFormatter, resolveTimezone } from '../sidebar/format';
import type { ChartSession } from './session';

/** At most one announcement per this many ms (screen readers cannot follow faster). */
export const LIVE_REGION_INTERVAL_MS = 500;

/** Accessible name of the chart canvas: its symbol and interval. */
export function useChartLabel(session: ChartSession | null): string {
  const t = useT();
  const [{ symbol, interval }, setSpec] = useState({ symbol: '', interval: '' });
  useEffect(() => {
    if (!session) return;
    const read = () => {
      const { symbol: s, interval: i } = session.view.getState();
      setSpec((cur) => (cur.symbol === s && cur.interval === i ? cur : { symbol: s, interval: i }));
    };
    read();
    return session.view.subscribe(read);
  }, [session]);
  return t('chart.label', { symbol, interval });
}

/**
 * Visually hidden polite live region announcing the OHLC of the bar under the
 * crosshair, throttled to one update per LIVE_REGION_INTERVAL_MS.
 */
export function ChartLiveRegion({ session }: { session: ChartSession }) {
  const t = useT();
  const [text, setText] = useState('');

  useEffect(() => {
    let lastTime: number | null = null;
    let last = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const announce = () => {
      timer = null;
      last = Date.now();
      const { crosshair, symbolInfo } = session.info.getState();
      const bar = crosshair?.bar;
      if (!bar || bar.time === lastTime) return;
      lastTime = bar.time;
      const { timezone, interval } = session.view.getState();
      const tz = resolveTimezone(timezone, symbolInfo?.timezone);
      const time = makeDateFormatter(tz, !/[DWM]$/.test(interval)).format(
        new Date(bar.time * 1000),
      );
      setText(
        t('chart.live', {
          time,
          open: fmtAuto(bar.open),
          high: fmtAuto(bar.high),
          low: fmtAuto(bar.low),
          close: fmtAuto(bar.close),
        }),
      );
    };
    const off = session.info.subscribe((s, p) => {
      if (s.crosshair?.bar === p.crosshair?.bar || timer) return;
      timer = setTimeout(announce, Math.max(0, LIVE_REGION_INTERVAL_MS - (Date.now() - last)));
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [session, t]);

  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
