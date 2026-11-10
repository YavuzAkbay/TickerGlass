import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRESETS,
  DEFAULT_COLUMNS,
  MAX_PRESETS,
  MAX_PRESET_NAME,
  WIDTH_MAX,
  WIDTH_MIN,
  parsePresets,
  parseWidths,
  presetFor,
  removePreset,
  sameColumns,
  upsertPreset,
  type ColumnPreset,
} from './presets';
import { PAGE_COLUMN_IDS, SIDEBAR_COLUMNS } from './registry';

describe('built-in presets', () => {
  it('only use columns their surface offers', () => {
    for (const p of BUILTIN_PRESETS) {
      for (const c of p.columns.sidebar) expect(SIDEBAR_COLUMNS).toContain(c);
      for (const c of p.columns.page) expect(PAGE_COLUMN_IDS).toContain(c);
    }
  });

  it('Default is the first-run column set of each surface', () => {
    expect(BUILTIN_PRESETS[0]!.columns).toEqual(DEFAULT_COLUMNS);
  });

  it('match the documented layouts', () => {
    const byId = Object.fromEntries(BUILTIN_PRESETS.map((p) => [p.id, p.columns.sidebar]));
    expect(byId.performance).toEqual([
      'last',
      'changePercent',
      'gapPercent',
      'relVolume',
      'week52Range',
    ]);
    expect(byId.technical).toEqual([
      'last',
      'changePercent',
      'perf1m',
      'rsi14',
      'pctVsSma200',
      'nextEarnings',
    ]);
    expect(byId.fundamentals).toEqual([
      'last',
      'changePercent',
      'marketCap',
      'avgVolume',
      'week52Range',
    ]);
    expect(byId.minimal).toEqual(['last', 'changePercent']);
  });
});

describe('parseWidths', () => {
  it('keeps known columns, clamps, drops junk', () => {
    expect(
      parseWidths({ last: 100.4, name: 5, volume: 9999, bogus: 80, change: 'x', open: NaN }),
    ).toEqual({
      last: 100,
      name: WIDTH_MIN,
      volume: WIDTH_MAX,
    });
    expect(parseWidths(null)).toEqual({});
  });
});

describe('parsePresets', () => {
  it('keeps column order, drops unknown ids and repeats', () => {
    const out = parsePresets([
      { name: ' Mine ', columns: ['trend', 'last', 'bogus', 'last'], widths: { last: 90 } },
    ]);
    expect(out).toEqual([{ name: 'Mine', columns: ['trend', 'last'], widths: { last: 90 } }]);
  });

  it('drops invalid, empty and duplicate-named presets', () => {
    const out = parsePresets([
      'x',
      null,
      { name: '', columns: ['last'] },
      { name: 'A', columns: [] },
      { name: 'A', columns: ['bogus'] },
      { name: 'Dup', columns: ['last'] },
      { name: 'dup', columns: ['volume'] },
      { columns: ['last'] },
    ]);
    expect(out.map((p) => p.name)).toEqual(['Dup']);
    expect(out[0]!.widths).toEqual({});
  });

  it('caps the count and the name length', () => {
    const many = Array.from({ length: MAX_PRESETS + 5 }, (_, i) => ({
      name: `p${i}`,
      columns: ['last'],
    }));
    expect(parsePresets(many)).toHaveLength(MAX_PRESETS);
    expect(parsePresets([{ name: 'x'.repeat(200), columns: ['last'] }])[0]!.name).toHaveLength(
      MAX_PRESET_NAME,
    );
    expect(parsePresets('nope')).toEqual([]);
  });
});

describe('preset list ops', () => {
  const a: ColumnPreset = { name: 'A', columns: ['last'], widths: {} };

  it('upsert replaces by case-insensitive name, appends new, refuses past the cap', () => {
    const replaced = upsertPreset([a], { ...a, name: 'a', columns: ['volume'] })!;
    expect(replaced).toEqual([{ name: 'a', columns: ['volume'], widths: {} }]);
    expect(upsertPreset([a], { ...a, name: 'B' })).toHaveLength(2);
    const full = Array.from({ length: MAX_PRESETS }, (_, i) => ({ ...a, name: `p${i}` }));
    expect(upsertPreset(full, { ...a, name: 'new' })).toBeNull();
    expect(upsertPreset(full, { ...a, name: 'P1' })).toHaveLength(MAX_PRESETS);
  });

  it('removes by name', () => {
    expect(removePreset([a, { ...a, name: 'B' }], 'A').map((p) => p.name)).toEqual(['B']);
  });

  it('presetFor filters to the surface; widths are page-only', () => {
    const p: ColumnPreset = {
      name: 'P',
      columns: ['name', 'dayRange', 'last', 'trend'],
      widths: { name: 200, last: 80, volume: 70 },
    };
    expect(presetFor(p, 'page')).toEqual({
      columns: ['name', 'dayRange', 'last', 'trend'],
      widths: { name: 200, last: 80 },
    });
    expect(presetFor(p, 'sidebar')).toEqual({ columns: ['last', 'trend'], widths: {} });
  });

  it('sameColumns compares order', () => {
    expect(sameColumns(['last', 'volume'], ['last', 'volume'])).toBe(true);
    expect(sameColumns(['volume', 'last'], ['last', 'volume'])).toBe(false);
  });
});
