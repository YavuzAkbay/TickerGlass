import { calendarPeriod } from '../calendar';
import { defineIndicator } from '../registry';
import { COLOR } from './common';

export const RELATIVE_VOLUME_MODES = ['Cumulative', 'Regular'] as const;

const DAY = 86_400;

/**
 * Relative Volume at Time. Intraday: k = bar offset within the session
 * (exchange trading day); Cumulative compares the session's volume through
 * bar k with the mean over the previous `length` sessions of their volume
 * through bar k, Regular compares bar k's volume with the mean of their bar-k
 * volumes. A previous session with fewer bars contributes its last bar (its
 * total in Cumulative mode). Daily and above: volume / mean of the previous
 * `length` volumes (every bar is its own session). NaN until `length`
 * previous sessions exist.
 */
export const RELATIVE_VOLUME = defineIndicator({
  id: 'relative-volume',
  name: 'Relative Volume at Time',
  shortName: 'RelVol',
  category: 'volume',
  keywords: ['relative volume', 'rvol', 'relvol', 'volume at time', 'volume'],
  overlay: false,
  precision: 2,
  inputs: {
    length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 500 },
    mode: {
      kind: 'enum',
      label: 'Calculation Mode',
      options: RELATIVE_VOLUME_MODES,
      default: 'Cumulative',
    },
  },
  outputs: [
    { type: 'hline', id: 'level', title: 'Level', value: 1, color: COLOR.level },
    { type: 'plot', id: 'rvol', title: 'Relative Volume', kind: 'columns', color: COLOR.blue },
  ],
  setup({ inputs, ta, env }) {
    const n = inputs.length;
    const cumulative = inputs.mode === 'Cumulative';
    const daily = env.intervalSeconds >= DAY;
    const st = ta.vars({ period: NaN, start: 0 });
    // Start bar of the previous sessions, newest first.
    const starts = ta.history(n);
    // Volume of the session through each bar.
    const sessionVolume = ta.series();
    return (c) => {
      const i = c.i;
      const period = daily ? i : calendarPeriod(c.time[i]!, 'session', env.timezone, env.session);
      if (period !== st.period) {
        if (!Number.isNaN(st.period)) starts.push(st.start);
        st.period = period;
        st.start = i;
      }
      const v = c.volume[i]!;
      const before = i === st.start ? 0 : sessionVolume.get(i - 1);
      const total = Number.isNaN(v) ? before : before + v;
      sessionVolume.set(i, total);
      if (Number.isNaN(starts.get(n - 1))) return;
      const k = i - st.start;
      let sum = 0;
      let end = st.start - 1;
      for (let j = 0; j < n; j++) {
        const s = starts.get(j);
        const at = Math.min(s + k, end);
        sum += cumulative ? sessionVolume.get(at) : c.volume[at]!;
        end = s - 1;
      }
      const cur = cumulative ? total : v;
      c.set('rvol', sum === 0 ? NaN : cur / (sum / n));
    };
  },
});
