import type { Drawing } from '@investopen/engine';
import { describe, expect, it } from 'vitest';
import { migrateToolIds } from '../store/ui';
import {
  mapToolKeys,
  migrateTemplates,
  parseDrawings,
  sanitizeDrawing,
  type DrawingTemplate,
} from './store';

const old = (type: string): Drawing => ({
  id: 'd1',
  type,
  points: [
    { time: 1, price: 10 },
    { time: 2, price: 20 },
  ],
  style: {},
  text: '',
  locked: false,
  hidden: false,
  zIndex: 1,
  visibility: null,
  scope: 'symbol',
  symbol: 'AAPL',
  paneId: 'main',
});

describe('renamed drawing tool ids', () => {
  it('loads a stored v1 drawing saved under an old type', () => {
    const raw = JSON.stringify({
      version: 1,
      bySymbol: { AAPL: [old('info-line'), { ...old('trend-line'), id: 'd2' }] },
      synced: [{ ...old('ghost-feed'), id: 'd3', scope: 'all' }],
    });
    const { bySymbol, synced } = parseDrawings(raw);
    expect(bySymbol.AAPL!.map((d) => d.type)).toEqual(['measured-line', 'trend-line']);
    expect(synced.map((d) => d.type)).toEqual(['path-sketch']);
  });

  it('maps the type of a drawing from the API or an import', () => {
    expect(sanitizeDrawing(old('flag-mark'))!.type).toBe('flag');
    expect(sanitizeDrawing(old('flag'))!.type).toBe('flag');
  });

  it('moves tool-keyed records to the new id (the new id wins)', () => {
    expect(mapToolKeys({ forecast: 1, ray: 2 })).toEqual({ 'price-target': 1, ray: 2 });
    expect(mapToolKeys({ forecast: 1, 'price-target': 9 })).toEqual({ 'price-target': 9 });
  });

  it('migrates stored toolbar preferences', () => {
    expect(
      migrateToolIds({
        activeTool: 'signpost',
        groupTools: { lines: 'info-line', fib: 'fib-retracement' },
        favoriteTools: ['info-line', 'measured-line', 'ray', 'forecast'],
        rightWidth: 300,
      }),
    ).toEqual({
      activeTool: 'pin',
      groupTools: { lines: 'measured-line', fib: 'fib-retracement' },
      favoriteTools: ['measured-line', 'ray', 'price-target'],
      rightWidth: 300,
    });
    expect(migrateToolIds({ activeTool: 5, groupTools: [], favoriteTools: 'x' })).toEqual({
      activeTool: 5,
      groupTools: [],
      favoriteTools: 'x',
    });
  });

  it('migrates stored templates and default styles', () => {
    const tpl: DrawingTemplate = { name: 'mine', style: { lineColor: '#fff' } };
    expect(
      migrateTemplates({
        byType: { 'sine-line': [tpl] },
        defaults: { 'double-curve': { lineColor: '#000' } },
      }),
    ).toEqual({ byType: { 'sine-wave': [tpl] }, defaults: { 's-curve': { lineColor: '#000' } } });
    expect(migrateTemplates(null)).toEqual({ byType: {}, defaults: {} });
  });
});
