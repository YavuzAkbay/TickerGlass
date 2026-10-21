import { describe, expect, it } from 'vitest';
import { getDrawingTool } from './registry';
import './tools';
import { LEGACY_DRAWING_TYPES, resolveDrawingType } from './legacy-ids';

describe('legacy drawing ids', () => {
  it('maps renamed ids to their current id', () => {
    expect(resolveDrawingType('info-line')).toBe('measured-line');
    expect(resolveDrawingType('forecast')).toBe('price-target');
    expect(resolveDrawingType('signpost')).toBe('pin');
    expect(resolveDrawingType('flag-mark')).toBe('flag');
  });

  it('passes current and unknown ids through', () => {
    expect(resolveDrawingType('trend-line')).toBe('trend-line');
    expect(resolveDrawingType('measured-line')).toBe('measured-line');
    expect(resolveDrawingType('toString')).toBe('toString');
    expect(resolveDrawingType('nope')).toBe('nope');
  });

  it('only maps onto registered tools, and never from a registered id', () => {
    for (const [old, now] of Object.entries(LEGACY_DRAWING_TYPES)) {
      expect(getDrawingTool(now), `${old} -> ${now}`).toBeDefined();
      expect(getDrawingTool(old), `${old} is still registered`).toBeUndefined();
    }
  });
});
