import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAlerts } from '../store';

/** "Alerts service is not running" when the API reports no recent heartbeat. */
export function ServiceBanner() {
  const service = useAlerts((s) => s.service);
  const status = useAlerts((s) => s.status);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (status === 'offline')
    return (
      <div className="al-banner" role="alert">
        <TriangleAlert size={14} /> Server unreachable; alerts cannot be loaded.
      </div>
    );
  if (!service || service.online) return null;
  const at = service.lastHeartbeatAt ? Date.parse(service.lastHeartbeatAt) : NaN;
  const age = Number.isFinite(at) ? ago(now - at) : null;
  return (
    <div className="al-banner" role="alert">
      <TriangleAlert size={14} />
      <span>
        Alerts service is not running; alerts will not fire
        {age ? ` (last heartbeat ${age} ago)` : ''}.
      </span>
    </div>
  );
}

function ago(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
