import { describe, expect, it } from 'vitest';
import {
  categoryOf,
  DOCK_CATEGORIES,
  dockTools,
  filterSections,
  matchesTool,
  QUICK_DEFAULTS,
  quickTools,
} from './dock';
import { findTool, TOOL_GROUPS } from './tools';

describe('drawing dock', () => {
  it('has five categories that cover every catalog tool except cursors', () => {
    expect(DOCK_CATEGORIES.map((c) => c.label)).toEqual([
      'Lines',
      'Shapes',
      'Text',
      'Measure',
      'Patterns',
    ]);
    const docked = new Set(dockTools().map((t) => t.id));
    for (const g of TOOL_GROUPS) {
      if (g.id === 'cursors') continue;
      for (const s of g.sections) for (const t of s.tools) expect(docked).toContain(t.id);
    }
    expect(docked).toContain('measure');
    expect(docked).toContain('zoom-in');
  });

  it('maps tools to their category', () => {
    expect(categoryOf('trend-line')?.id).toBe('lines');
    expect(categoryOf('fib-retracement')?.id).toBe('measure');
    expect(categoryOf('long-position')?.id).toBe('measure');
    expect(categoryOf('text')?.id).toBe('text');
    expect(categoryOf('cross')).toBeUndefined();
  });

  it('searches by substring and word starts', () => {
    const fib = findTool('fib-retracement')!;
    expect(matchesTool(fib, 'retrace')).toBe(true);
    expect(matchesTool(fib, 'fib re')).toBe(true);
    expect(matchesTool(fib, 'gann')).toBe(false);
    const lines = DOCK_CATEGORIES[0]!;
    const hits = filterSections(lines.sections, 'chan').flatMap((s) => s.tools.map((t) => t.id));
    expect(hits).toContain('parallel-channel');
    expect(hits).not.toContain('trend-line');
    expect(filterSections(lines.sections, 'zzz')).toEqual([]);
  });

  it('quick tools: favorites first, defaults otherwise, unknown ids dropped', () => {
    expect(quickTools([]).map((t) => t.id)).toEqual(
      QUICK_DEFAULTS.filter((id) => quickTools([id]).length),
    );
    expect(quickTools(['gann-box', 'nope']).map((t) => t.id)).toEqual(['gann-box']);
  });
});
