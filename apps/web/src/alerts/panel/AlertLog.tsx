import type { AlertDelivery, AlertLogEntry } from '@tickerglass/alerts';
import { useEffect, useMemo, useRef, useState } from 'react';
import { confirmDialog } from '../../ui/Prompt';
import { useAlerts } from '../store';
import { clearAlertLog, loadMoreAlertLog, markLogRead } from '../sync';

function chip(d: AlertDelivery) {
  const title = d.lastError ? `${d.channel}: ${d.lastError}` : `${d.channel}: ${d.status}`;
  return (
    <span key={d.channel} className={`al-chip al-chip-${d.status}`} title={title}>
      {d.channel}
    </span>
  );
}

function Entry({ e, focused }: { e: AlertLogEntry; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  const at = new Date(e.firedAt);
  return (
    <div
      ref={ref}
      className={`al-entry${e.read ? '' : ' unread'}${focused ? ' focused' : ''}`}
      data-log-id={e.id}
    >
      <div className="al-entry-head">
        <span className="al-entry-name">{e.alertName}</span>
        <time dateTime={e.firedAt}>
          {Number.isNaN(at.getTime()) ? e.firedAt : at.toLocaleString()}
        </time>
      </div>
      <div className="al-entry-msg">{e.message}</div>
      <div className="al-entry-meta">
        {e.symbol} · {e.interval}
        {e.delayed ? ' · delayed' : ''}
        {e.final ? ' · final' : ''}
        {e.deliveries.map(chip)}
      </div>
    </div>
  );
}

/** Log tab: newest first, marks read while visible, loads older pages on scroll. */
export function AlertLog() {
  const log = useAlerts((s) => s.log);
  const alerts = useAlerts((s) => s.alerts);
  const hasMore = useAlerts((s) => s.logHasMore);
  const unread = useAlerts((s) => s.unread);
  const focus = useAlerts((s) => s.focusEntry);
  const [alertId, setAlertId] = useState('');
  const sentinel = useRef<HTMLDivElement>(null);
  const shown = useMemo(
    () => (alertId ? log.filter((e) => e.alertId === alertId) : log),
    [log, alertId],
  );
  const newest = log[0]?.id;
  const hasUnread = log.some((e) => !e.read);

  // Visible tab: whatever arrives is read.
  useEffect(() => {
    if (newest !== undefined && hasUnread && document.visibilityState === 'visible')
      void markLogRead(newest);
  }, [newest, hasUnread]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((hits) => {
      if (hits.some((h) => h.isIntersecting)) void loadMoreAlertLog();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, shown.length]);

  return (
    <div className="al-log">
      <div className="al-tools">
        <select
          className="io-input al-log-filter"
          aria-label="Filter by alert"
          value={alertId}
          onChange={(e) => setAlertId(e.target.value)}
        >
          <option value="">All alerts</option>
          {Object.values(alerts).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="io-btn"
          disabled={!unread}
          onClick={() => void markLogRead(newest)}
        >
          Mark all read
        </button>
        <button
          type="button"
          className="io-btn"
          disabled={!log.length}
          onClick={() => {
            void confirmDialog({
              title: 'Clear log',
              message: alertId ? 'Clear the log of this alert?' : 'Clear the whole alert log?',
              okLabel: 'Clear',
              danger: true,
            }).then((ok) => {
              if (ok) void clearAlertLog(alertId || undefined);
            });
          }}
        >
          Clear log
        </button>
      </div>
      {shown.length ? (
        shown.map((e) => <Entry key={e.id} e={e} focused={e.id === focus} />)
      ) : (
        <div className="rs-empty-text al-none">No alerts have fired.</div>
      )}
      {hasMore ? <div ref={sentinel} className="al-more-log" aria-hidden /> : null}
    </div>
  );
}
