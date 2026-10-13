import { AlarmClock, Plus } from 'lucide-react';
import { commands } from '../../commands/registry';

export function Alerts() {
  return (
    <div className="rs-empty">
      <AlarmClock size={40} strokeWidth={1.2} />
      <div className="rs-empty-title">No alerts yet</div>
      <div className="rs-empty-text">Alerts arrive in Phase 10</div>
      <button
        type="button"
        className="io-btn io-btn-primary rs-empty-btn"
        onClick={() => commands.execute('alert.create')}
      >
        <Plus size={16} /> Create alert
      </button>
    </div>
  );
}
