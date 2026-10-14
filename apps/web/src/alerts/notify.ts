/** In-app alert notifications: toast, sound and browser Notification (docs/alerts.md §5.6). */
import type { AlertLogEntry, AlertNotify } from '@investopen/alerts';
import { actionToast } from '../ui/Toast';
import { onAlertFired, type FiredAlertInfo } from './events';
import { openAlertLog, useAlerts } from './store';
import { readAlertPrefs, type AlertPrefs } from './prefs';
import { playSound } from './sound';

export type Visibility = 'visible' | 'hidden';
export type NotifPermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** Used when the alert is unknown (deleted, or not loaded yet). */
export const DEFAULT_NOTIFY: Pick<AlertNotify, 'toast' | 'sound' | 'browser'> = {
  toast: true,
  sound: true,
  browser: false,
};

/** Sound rings only in visible tabs, so several open tabs normally ring once. */
export function shouldPlaySound(notify: Pick<AlertNotify, 'sound'>, vis: Visibility): boolean {
  return notify.sound && vis === 'visible';
}

/** A browser notification only when this tab is hidden and permission was granted. */
export function shouldBrowserNotify(
  notify: Pick<AlertNotify, 'browser'>,
  vis: Visibility,
  permission: NotifPermission,
): boolean {
  return notify.browser && vis === 'hidden' && permission === 'granted';
}

/** Same tag in every tab: the browser merges the duplicates. */
export const notificationTag = (entry: Pick<AlertLogEntry, 'id'>): string => `alert-${entry.id}`;

export interface NotifyDeps {
  visibility: () => Visibility;
  permission: () => NotifPermission;
  prefs: () => AlertPrefs;
  notifyFor: (entry: AlertLogEntry) => Pick<AlertNotify, 'toast' | 'sound' | 'browser'>;
  toast: (message: string, ms: number, openLog: () => void) => void;
  sound: (prefs: AlertPrefs) => void;
  browser: (title: string, options: { body: string; tag: string }, onClick: () => void) => void;
  openLog: (id: number) => void;
}

/** Handle one fire; returns which channels ran. */
export function notifyFire(deps: NotifyDeps, entry: AlertLogEntry) {
  const notify = deps.notifyFor(entry);
  const prefs = deps.prefs();
  const vis = deps.visibility();
  const ran = { toast: false, sound: false, browser: false };
  if (notify.toast) {
    deps.toast(entry.message, prefs.toastMs, () => deps.openLog(entry.id));
    ran.toast = true;
  }
  if (shouldPlaySound(notify, vis)) {
    deps.sound(prefs);
    ran.sound = true;
  }
  if (shouldBrowserNotify(notify, vis, deps.permission())) {
    deps.browser(entry.alertName, { body: entry.message, tag: notificationTag(entry) }, () =>
      deps.openLog(entry.id),
    );
    ran.browser = true;
  }
  return ran;
}

export const browserPermission = (): NotifPermission =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/** Ask for notification permission (from a user gesture). */
export async function requestBrowserPermission(): Promise<NotifPermission> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

const liveDeps = (): NotifyDeps => ({
  visibility: () => (document.visibilityState === 'hidden' ? 'hidden' : 'visible'),
  permission: browserPermission,
  prefs: readAlertPrefs,
  notifyFor: (entry) =>
    (entry.alertId ? useAlerts.getState().alerts[entry.alertId]?.notify : undefined) ??
    DEFAULT_NOTIFY,
  toast: (message, ms, openLog) =>
    void actionToast(message, [{ label: 'Open log', run: openLog }], 'info', ms),
  sound: (p) => void playSound(p.sound, p.volume),
  browser: (title, options, onClick) => {
    try {
      const n = new Notification(title, options);
      n.onclick = () => {
        window.focus();
        onClick();
        n.close();
      };
    } catch (err) {
      console.warn('browser notification failed', err);
    }
  },
  openLog: (id) => openAlertLog(id),
});

/** Notify on every fire (from `persist/bootstrap.ts`); returns the stop function. */
export function startAlertNotifications(deps: NotifyDeps = liveDeps()): () => void {
  return onAlertFired((entry: AlertLogEntry, _alert: FiredAlertInfo | null) => {
    notifyFire(deps, entry);
  });
}
