/** Settings -> Events tab. Changes apply immediately (`events.prefs`). */
import { Section, Setting } from '../dialogs/controls';
import { useEventPrefs } from './prefs';

export function EventsTab() {
  const prefs = useEventPrefs();
  return (
    <Section title="On the chart">
      <Setting
        checked={prefs.dividends}
        label="Dividends (D)"
        onChange={(dividends) => prefs.set({ dividends })}
      />
      <Setting
        checked={prefs.splits}
        label="Splits (S)"
        onChange={(splits) => prefs.set({ splits })}
      />
      <Setting
        checked={prefs.earnings}
        label="Earnings (E), including the next expected date"
        onChange={(earnings) => prefs.set({ earnings })}
      />
    </Section>
  );
}
