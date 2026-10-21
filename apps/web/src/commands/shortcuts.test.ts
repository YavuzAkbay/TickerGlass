import { describe, expect, it } from 'vitest';
import { comboFromEvent, normalize } from './shortcuts';

const key = (k: string, code: string, mods: Partial<KeyboardEvent> = {}) =>
  ({
    key: k,
    code,
    altKey: false,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  }) as KeyboardEvent;

describe('shortcut matching', () => {
  it('matches Shift+Alt+Space against the space key', () => {
    const combo = comboFromEvent(key(' ', 'Space', { altKey: true, shiftKey: true }));
    expect(combo).toBe('Alt+Shift+Space');
    expect(normalize('Shift+Alt+Space')).toBe(combo);
  });

  it('matches Shift+Alt+ArrowRight and Shift+Alt+r (layout-stable via the key code)', () => {
    const arrow = comboFromEvent(key('ArrowRight', 'ArrowRight', { altKey: true, shiftKey: true }));
    expect(normalize('Shift+Alt+ArrowRight')).toBe(arrow);
    const r = comboFromEvent(key('®', 'KeyR', { altKey: true, shiftKey: true }));
    expect(normalize('Shift+Alt+r')).toBe(r);
  });
});
