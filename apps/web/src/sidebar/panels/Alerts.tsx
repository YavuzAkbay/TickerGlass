import { AlertLog } from '../../alerts/panel/AlertLog';
import { AlertList } from '../../alerts/panel/AlertList';
import { ServiceBanner } from '../../alerts/panel/ServiceBanner';
import { useAlerts } from '../../alerts/store';
import '../../alerts/panel/panel.css';

/** Alerts and the notification log. */
export function Alerts() {
  const tab = useAlerts((s) => s.tab);
  const unread = useAlerts((s) => s.unread);
  const set = (t: 'alerts' | 'log') => useAlerts.setState({ tab: t, focusEntry: null });
  return (
    <div className="al-panel">
      <ServiceBanner />
      <div className="rs-notes-tabs al-tabs" role="tablist" aria-label="Alerts">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'alerts'}
          className={`rs-notes-tab${tab === 'alerts' ? ' active' : ''}`}
          onClick={() => set('alerts')}
        >
          Alerts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'log'}
          className={`rs-notes-tab${tab === 'log' ? ' active' : ''}`}
          onClick={() => set('log')}
        >
          Log
          {unread ? <span className="al-badge">{unread > 99 ? '99+' : unread}</span> : null}
        </button>
      </div>
      {tab === 'alerts' ? <AlertList /> : <AlertLog />}
    </div>
  );
}
