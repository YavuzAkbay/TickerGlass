import { describeCondition, type Alert } from '@investopen/alerts';
import { Copy, MoreHorizontal, Pause, Pencil, Play, RotateCcw, Trash2 } from 'lucide-react';
import type { MouseEvent } from 'react';
import { commands } from '../../commands/registry';
import { openContextMenu } from '../../ui/ContextMenu';
import type { MenuItem } from '../../ui/Menu';
import { confirmDialog } from '../../ui/Prompt';
import { cloneAlert, deleteAlert, setAlertStatus } from '../sync';

const TRIGGER_LABELS: Record<Alert['spec']['trigger'], string> = {
  once: 'Only once',
  oncePerBar: 'Once per bar',
  oncePerBarClose: 'Once per bar close',
  everyTime: 'Every time',
};

export function expiryText(a: Pick<Alert, 'expiresAt' | 'status'>): string | null {
  if (!a.expiresAt) return null;
  const d = new Date(a.expiresAt);
  const text = Number.isNaN(d.getTime()) ? a.expiresAt : d.toLocaleString();
  return a.status === 'expired' ? `Expired ${text}` : `Expires ${text}`;
}

export function alertMenu(alert: Alert, x: number, y: number): void {
  const restart =
    alert.status === 'triggered' || alert.status === 'expired' || alert.status === 'error';
  const items: MenuItem[] = [
    {
      label: 'Edit…',
      icon: Pencil,
      onSelect: () => commands.execute('alert.edit', { id: alert.id }),
    },
    alert.status === 'active'
      ? { label: 'Pause', icon: Pause, onSelect: () => void setAlertStatus(alert.id, 'paused') }
      : alert.status === 'paused'
        ? { label: 'Resume', icon: Play, onSelect: () => void setAlertStatus(alert.id, 'active') }
        : {
            label: 'Restart',
            icon: RotateCcw,
            disabled: !restart,
            onSelect: () => void setAlertStatus(alert.id, 'active'),
          },
    { label: 'Clone', icon: Copy, onSelect: () => cloneAlert(alert.id) },
    { type: 'separator' },
    {
      label: 'Delete…',
      icon: Trash2,
      danger: true,
      onSelect: () => {
        void confirmDialog({
          title: 'Delete alert',
          message: `Delete “${alert.name}”? Its log entries are kept.`,
          okLabel: 'Delete',
          danger: true,
        }).then((ok) => {
          if (ok) void deleteAlert(alert.id);
        });
      },
    },
  ];
  openContextMenu(x, y, items);
}

/** One alert: status dot, name, condition, symbol, trigger, expiry and fire count. */
export function AlertRow({ alert }: { alert: Alert }) {
  const open = () => {
    commands.execute('chart.setSymbol', alert.symbol);
    commands.execute('chart.setInterval', alert.interval);
  };
  const menuAt = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    alertMenu(alert, e.clientX, e.clientY);
  };
  const expiry = expiryText(alert);
  return (
    <div
      className={`al-row al-${alert.status}`}
      role="button"
      tabIndex={0}
      data-alert-id={alert.id}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open();
      }}
      onContextMenu={menuAt}
    >
      <span
        className={`al-dot al-dot-${alert.status}`}
        title={alert.status}
        aria-label={alert.status}
      />
      <div className="al-main">
        <div className="al-name">{alert.name}</div>
        <div className="al-cond">{describeCondition(alert)}</div>
        <div className="al-meta">
          {alert.symbol} · {alert.interval} · {TRIGGER_LABELS[alert.spec.trigger]}
          {expiry ? ` · ${expiry}` : ''}
          {alert.fireCount ? ` · fired ${alert.fireCount}×` : ''}
        </div>
        {alert.status === 'error' && alert.statusReason ? (
          <div className="al-reason">{alert.statusReason}</div>
        ) : null}
      </div>
      <button
        type="button"
        className="io-icon-btn al-more"
        aria-label={`Actions for ${alert.name}`}
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          alertMenu(alert, r.left, r.bottom);
        }}
      >
        <MoreHorizontal size={16} />
      </button>
    </div>
  );
}
