/** Settings -> Alerts tab (docs/alerts.md §5.6). Changes apply immediately (`alerts.prefs`). */
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/client';
import * as alertsApi from '../api/alerts';
import type { AlertChannels } from '../api/alerts';
import { Row, Section, Setting } from '../dialogs/controls';
import { toast } from '../ui/Toast';
import { browserPermission, requestBrowserPermission, type NotifPermission } from './notify';
import { SOUND_NAMES, useAlertPrefs, type SoundName } from './prefs';
import { playSound } from './sound';

const CHANNELS = ['webhook', 'telegram', 'email'] as const;

const PERMISSION_TEXT: Record<NotifPermission, string> = {
  granted: 'Allowed',
  default: 'Not asked yet',
  denied: 'Blocked by the browser',
  unsupported: 'Not supported by this browser',
};

export function AlertsSettingsTab() {
  const prefs = useAlertPrefs();
  const [permission, setPermission] = useState<NotifPermission>(browserPermission);
  const [channels, setChannels] = useState<AlertChannels | null>(null);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    alertsApi
      .getAlertChannels()
      .then((c) => live && setChannels(c))
      .catch((err) => live && setChannelsError(errorMessage(err)));
    return () => {
      live = false;
    };
  }, []);

  const test = async (channel: (typeof CHANNELS)[number]) => {
    setTesting(channel);
    try {
      await alertsApi.testAlertChannel(channel);
      toast(`Test sent to ${channel}`, 'success');
    } catch (err) {
      toast(`Test failed: ${errorMessage(err)}`, 'error');
    } finally {
      setTesting(null);
    }
  };

  return (
    <>
      <Section title="On the chart">
        <Setting
          checked={prefs.lines}
          label="Show lines for active price alerts"
          onChange={(lines) => prefs.set({ lines })}
        />
        <Setting
          checked={prefs.markers}
          label="Show markers for fired alerts"
          onChange={(markers) => prefs.set({ markers })}
        />
      </Section>
      <Section title="Notifications">
        <Row label="Sound" htmlFor="set-alert-sound">
          <select
            id="set-alert-sound"
            className="io-input dlg-select"
            value={prefs.sound}
            onChange={(e) => prefs.set({ sound: e.target.value as SoundName })}
          >
            {SOUND_NAMES.map((n) => (
              <option key={n} value={n}>
                {n[0]!.toUpperCase() + n.slice(1)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="io-btn"
            onClick={() => {
              if (!playSound(prefs.sound, prefs.volume)) toast('Sound is muted or unavailable');
            }}
          >
            Preview
          </button>
        </Row>
        <Row label="Volume" htmlFor="set-alert-volume">
          <input
            id="set-alert-volume"
            type="range"
            min={0}
            max={100}
            value={Math.round(prefs.volume * 100)}
            onChange={(e) => prefs.set({ volume: Number(e.target.value) / 100 })}
          />
        </Row>
        <Row label="Hide toasts after" htmlFor="set-alert-toast">
          <input
            id="set-alert-toast"
            type="number"
            min={0}
            max={600}
            className="io-input"
            value={Math.round(prefs.toastMs / 1000)}
            onChange={(e) => {
              const s = Number(e.target.value);
              if (Number.isFinite(s)) prefs.set({ toastMs: s * 1000 });
            }}
          />
          <span className="dlg-number-suffix">seconds (0 keeps them)</span>
        </Row>
        <Row label="Browser notifications">
          <span>{PERMISSION_TEXT[permission]}</span>
          {(permission === 'default' || permission === 'denied') && (
            <button
              type="button"
              className="io-btn"
              disabled={permission === 'denied'}
              onClick={() => void requestBrowserPermission().then(setPermission)}
            >
              Allow
            </button>
          )}
        </Row>
      </Section>
      <Section title="Channels">
        {channelsError && <div role="alert">{channelsError}</div>}
        {!channels && !channelsError && <div>Loading...</div>}
        {channels &&
          CHANNELS.map((c) => (
            <Row key={c} label={c[0]!.toUpperCase() + c.slice(1)}>
              <span>{channels[c].configured ? 'Configured' : 'Not configured'}</span>
              <button
                type="button"
                className="io-btn"
                disabled={!channels[c].configured || testing !== null}
                onClick={() => void test(c)}
              >
                Send test
              </button>
            </Row>
          ))}
      </Section>
    </>
  );
}
