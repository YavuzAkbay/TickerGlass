import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The picker renders through <Modal>, a portal host the server renderer skips.
vi.mock('../ui/Modal', () => ({
  Modal: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

import IndicatorsDialog, {
  buildSections,
  groupByCategory,
  highlightMatch,
  matchesQuery,
} from './IndicatorsDialog';
import { getIndicator } from '@tickerglass/indicators';
import { createInstance } from '../indicators/model';
import { useIndicatorPrefs, useIndicatorStore } from '../indicators/store';

function renderPicker(): string {
  return renderToStaticMarkup(<IndicatorsDialog onClose={() => undefined} />);
}

beforeEach(() => {
  useIndicatorStore.setState({ instances: [] });
  useIndicatorPrefs.setState({ favorites: [], recents: [], defaults: {} });
});

describe('matchesQuery', () => {
  it('matches every word against name, short name, id and keywords', () => {
    const def = getIndicator('rsi')!;
    expect(matchesQuery(def, 'relative')).toBe(true);
    expect(matchesQuery(def, 'RSI')).toBe(true);
    expect(matchesQuery(def, 'relative strength')).toBe(true);
    expect(matchesQuery(def, 'relative nope')).toBe(false);
  });
});

describe('highlightMatch', () => {
  it('marks case-insensitive matches of any query word', () => {
    const html = renderToStaticMarkup(<>{highlightMatch('Relative Strength Index', ['index'])}</>);
    expect(html).toContain('<mark>Index</mark>');
  });

  it('returns plain text when nothing matches', () => {
    expect(highlightMatch('Aroon', [])).toBe('Aroon');
    expect(highlightMatch('Aroon', ['zzz'])).toBe('Aroon');
  });
});

describe('groupByCategory', () => {
  it('keeps the canonical category order and drops empty categories', () => {
    const sma = getIndicator('sma')!;
    const rsi = getIndicator('rsi')!;
    const sections = groupByCategory([rsi, sma]);
    expect(sections.map((s) => s.key)).toEqual(['movingAverage', 'momentum']);
    expect(sections[0]!.defs).toEqual([sma]);
    expect(sections[1]!.defs).toEqual([rsi]);
  });
});

describe('buildSections', () => {
  const defs = [getIndicator('sma')!, getIndicator('rsi')!, getIndicator('atr')!];

  it('pins known recents above the All list and excludes them from it', () => {
    const sections = buildSections({ q: '', cat: 'builtin', defs, recents: ['rsi', 'missing'] });
    expect(sections.map((s) => s.key)).toEqual(['recent', 'all']);
    expect(sections[0]!.defs.map((d) => d.id)).toEqual(['rsi']);
    expect(sections[1]!.defs.map((d) => d.id)).toEqual(['sma', 'atr']);
  });

  it('caps the recents shortcut', () => {
    const all = ['sma', 'ema', 'wma', 'dema', 'tema', 'hma', 'kama', 'rsi'].map((t) =>
      getIndicator(t)!,
    );
    const recents = ['sma', 'ema', 'wma', 'dema', 'tema', 'hma', 'kama'];
    const sections = buildSections({ q: '', cat: 'builtin', defs: all, recents });
    expect(sections[0]!.defs).toHaveLength(6);
    expect(sections[1]!.defs).toHaveLength(2);
  });

  it('returns no sections without recents and for flat views', () => {
    expect(buildSections({ q: '', cat: 'builtin', defs, recents: [] })).toEqual([]);
    expect(buildSections({ q: '', cat: 'momentum', defs, recents: ['rsi'] })).toEqual([]);
    expect(buildSections({ q: '', cat: 'custom', defs, recents: ['rsi'] })).toEqual([]);
  });

  it('groups search and starred views by category', () => {
    expect(buildSections({ q: 's', cat: 'builtin', defs, recents: [] }).map((s) => s.key)).toEqual([
      'movingAverage',
      'momentum',
      'volatility',
    ]);
    expect(buildSections({ q: '', cat: 'starred', defs, recents: [] }).map((s) => s.key)).toEqual([
      'movingAverage',
      'momentum',
      'volatility',
    ]);
  });
});

describe('IndicatorsDialog render', () => {
  it('lists indicators with names, short names, category counts and a detail pane', () => {
    const html = renderPicker();
    expect(html).toContain('Relative Strength Index');
    expect(html).toContain('Commodity Channel Index');
    expect(html).toContain('dlg-side-count');
    expect(html).toContain('Indicator details');
    expect(html).toContain('Add to chart');
    // The highlighted row's description previews in the detail pane.
    expect(html).toContain('ind-detail-desc');
  });

  it('shows an on-chart badge for applied indicators', () => {
    const rsi = getIndicator('rsi')!;
    useIndicatorStore.setState({ instances: [createInstance(rsi, undefined, {})] });
    const html = renderPicker();
    expect(html).toContain('ind-onchart');
    expect(html).toContain('1 on chart');
  });

  it('renders no section headers without recents', () => {
    expect(renderPicker()).not.toContain('ind-sec-head');
  });
});
