/** Settings -> Events tab. Changes apply immediately (`events.prefs`). */
import { Check, Section } from '../dialogs/controls';
import { useEventPrefs } from './prefs';

export function EventsTab() {
  const prefs = useEventPrefs();
  return (
    <Section title="On the chart">
      <Check
        checked={prefs.dividends}
        label="Dividends (D)"
        onChange={(dividends) => prefs.set({ dividends })}
      />
      <Check
        checked={prefs.splits}
        label="Splits (S)"
        onChange={(splits) => prefs.set({ splits })}
      />
      <Check
        checked={prefs.earnings}
        label="Earnings (E), including the next expected date"
        onChange={(earnings) => prefs.set({ earnings })}
      />
    </Section>
  );
}
