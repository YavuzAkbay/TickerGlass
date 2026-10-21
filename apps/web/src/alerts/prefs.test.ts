import { describe, expect, it } from 'vitest';
import { parseAlertPrefs } from './prefs';

describe('parseAlertPrefs', () => {
  it('keeps valid fields and clamps numbers', () => {
    expect(
      parseAlertPrefs({ sound: 'alarm', volume: 3, toastMs: -5, lines: false, markers: true }),
    ).toEqual({ sound: 'alarm', volume: 1, toastMs: 0, lines: false, markers: true });
  });
  it('drops invalid fields', () => {
    expect(parseAlertPrefs({ sound: 'nope', volume: 'x', lines: 1, toastMs: NaN })).toEqual({});
    expect(parseAlertPrefs(null)).toEqual({});
  });
});
