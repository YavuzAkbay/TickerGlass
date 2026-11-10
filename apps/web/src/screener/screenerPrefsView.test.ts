import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCREENER_PREFS,
  migrateScreenerPrefs,
  parseScreenerPrefs,
  SCREENER_GROUP_BYS,
} from './screenerPrefs';

describe('screener view and groupBy prefs', () => {
  it('default to the table, ungrouped', () => {
    expect(DEFAULT_SCREENER_PREFS.view).toBe('table');
    expect(DEFAULT_SCREENER_PREFS.groupBy).toBe('none');
  });

  it('parse valid values', () => {
    expect(parseScreenerPrefs({ view: 'heatmap', groupBy: 'sector' })).toMatchObject({
      view: 'heatmap',
      groupBy: 'sector',
    });
    for (const g of SCREENER_GROUP_BYS) expect(parseScreenerPrefs({ groupBy: g }).groupBy).toBe(g);
  });

  it('ignore invalid values so the defaults apply', () => {
    const out = parseScreenerPrefs({ view: 'cards', groupBy: 'industry' });
    expect(out.view).toBeUndefined();
    expect(out.groupBy).toBeUndefined();
  });

  it('older stored prefs (no view) migrate unchanged', () => {
    const old = { tab: 'stocks', columns: ['name'] };
    expect(parseScreenerPrefs(migrateScreenerPrefs(old, 4)).view).toBeUndefined();
  });
});
