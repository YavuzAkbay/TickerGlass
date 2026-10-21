/** Settings -> Trading tab. Changes apply immediately (`replay.trading`). */
import { Section, Setting } from '../dialogs/controls';
import { useTradingPrefs } from './prefs';

export function TradingTab() {
  const prefs = useTradingPrefs();
  return (
    <Section title="Replay paper trading on the chart">
      <Setting
        checked={prefs.tradeMarkers}
        label="Trade markers on the filled bars"
        onChange={(tradeMarkers) => prefs.set({ tradeMarkers })}
      />
      <Setting
        checked={prefs.positionLine}
        label="Position line at the average price"
        onChange={(positionLine) => prefs.set({ positionLine })}
      />
      <Setting
        checked={prefs.pnlLabel}
        label="Profit and loss in the position line label"
        onChange={(pnlLabel) => prefs.set({ pnlLabel })}
      />
    </Section>
  );
}
