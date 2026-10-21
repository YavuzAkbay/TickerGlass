import { calendarPeriod } from '../calendar';
import { defineIndicator } from '../registry';
import { profileOutput, VP_INPUTS } from './vp-visible';

/**
 * Volume Profile (Session): one profile per trading session, computed and drawn
 * by the engine from the chart's bars. The values array marks the first bar of
 * every session (1, else NaN) in the exchange calendar (overnight sessions
 * start on the previous date, see `calendarPeriod`).
 */
export const VP_SESSION = defineIndicator({
  id: 'vp-session',
  name: 'Volume Profile (Session)',
  shortName: 'VP Sess',
  category: 'volume',
  keywords: ['volume profile', 'svp', 'session', 'poc', 'value area', 'vp'],
  overlay: true,
  inputs: VP_INPUTS,
  outputs: [profileOutput('session')],
  setup({ ta }) {
    const s = ta.vars({ period: NaN });
    return (c) => {
      const period = calendarPeriod(c.time[c.i]!, 'session', c.env.timezone, c.env.session);
      if (period !== s.period) c.set('vp', 1);
      s.period = period;
    };
  },
});
