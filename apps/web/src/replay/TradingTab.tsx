/** Settings -> Trading tab. Changes apply immediately (`replay.trading`). */
import { Check, Section } from '../dialogs/controls';
import { useTradingPrefs } from './prefs';

export function TradingTab() {
  const prefs = useTradingPrefs();
  return (
    <Section title="Replay paper trading on the chart">
      <Check
        checked={prefs.tradeMarkers}
        label="Trade markers on the filled bars"
        onChange={(tradeMarkers) => prefs.set({ tradeMarkers })}
      />
      <Check
        checked={prefs.positionLine}
        label="Position line at the average price"
        onChange={(positionLine) => prefs.set({ positionLine })}
      />
      <Check
        checked={prefs.pnlLabel}
        label="Profit and loss in the position line label"
        onChange={(pnlLabel) => prefs.set({ pnlLabel })}
      />
    </Section>
  );
}
