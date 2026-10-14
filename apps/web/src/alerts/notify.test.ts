import type { AlertLogEntry } from '@investopen/alerts';
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_NOTIFY,
  notificationTag,
  notifyFire,
  shouldBrowserNotify,
  shouldPlaySound,
  type NotifyDeps,
  type Visibility,
} from './notify';
import { DEFAULT_ALERT_PREFS } from './prefs';

const entry = (id: number): AlertLogEntry =>
  ({ id, alertName: 'A', message: 'hit' }) as AlertLogEntry;

describe('visibility rules', () => {
  it('sound only when the tab is visible and enabled', () => {
    expect(shouldPlaySound({ sound: true }, 'visible')).toBe(true);
    expect(shouldPlaySound({ sound: true }, 'hidden')).toBe(false);
    expect(shouldPlaySound({ sound: false }, 'visible')).toBe(false);
  });
  it('browser notification only when hidden, enabled and granted', () => {
    expect(shouldBrowserNotify({ browser: true }, 'hidden', 'granted')).toBe(true);
    expect(shouldBrowserNotify({ browser: true }, 'visible', 'granted')).toBe(false);
    expect(shouldBrowserNotify({ browser: true }, 'hidden', 'denied')).toBe(false);
    expect(shouldBrowserNotify({ browser: true }, 'hidden', 'default')).toBe(false);
    expect(shouldBrowserNotify({ browser: true }, 'hidden', 'unsupported')).toBe(false);
    expect(shouldBrowserNotify({ browser: false }, 'hidden', 'granted')).toBe(false);
  });
});

function deps(vis: Visibility, notify = { ...DEFAULT_NOTIFY, browser: true }) {
  const d = {
    visibility: () => vis,
    permission: () => 'granted' as const,
    prefs: () => ({ ...DEFAULT_ALERT_PREFS, toastMs: 1234 }),
    notifyFor: () => notify,
    toast: vi.fn(),
    sound: vi.fn(),
    browser: vi.fn(),
    openLog: vi.fn(),
  } satisfies NotifyDeps;
  return d;
}

describe('notifyFire', () => {
  it('visible tab: toast and sound, no browser notification', () => {
    const d = deps('visible');
    expect(notifyFire(d, entry(5))).toEqual({ toast: true, sound: true, browser: false });
    expect(d.toast).toHaveBeenCalledWith('hit', 1234, expect.any(Function));
    d.toast.mock.calls[0]![2]();
    expect(d.openLog).toHaveBeenCalledWith(5);
  });
  it('hidden tab: toast and browser notification, no sound', () => {
    const d = deps('hidden');
    expect(notifyFire(d, entry(5))).toEqual({ toast: true, sound: false, browser: true });
    expect(d.browser).toHaveBeenCalledWith(
      'A',
      { body: 'hit', tag: 'alert-5' },
      expect.any(Function),
    );
  });
  it('respects the alert notify flags', () => {
    const d = deps('visible', { toast: false, sound: false, browser: false });
    expect(notifyFire(d, entry(1))).toEqual({ toast: false, sound: false, browser: false });
  });
  it('tabs share the tag per entry, differ across entries', () => {
    const a = deps('hidden');
    const b = deps('hidden');
    notifyFire(a, entry(7));
    notifyFire(b, entry(7));
    notifyFire(b, entry(8));
    expect(a.browser.mock.calls[0]![1].tag).toBe(b.browser.mock.calls[0]![1].tag);
    expect(b.browser.mock.calls[1]![1].tag).not.toBe(b.browser.mock.calls[0]![1].tag);
    expect(notificationTag(entry(7))).toBe('alert-7');
  });
});
