import { getIndicator } from '@investopen/indicators';
import { beforeEach, describe, expect, it } from 'vitest';
import { useHistory } from '../commands/history';
import {
  addIndicator,
  commitPreview,
  discardPreview,
  findIndicator,
  previewIndicator,
  removeIndicator,
  toggleIndicatorVisible,
  updateIndicator,
} from './actions';
import {
  createInstance,
  defaultVisibility,
  resolveTimeframe,
  studyTitle,
  validateInstances,
  visibleOnInterval,
} from './model';
import {
  effectiveInstances,
  useIndicatorPrefs,
  useIndicatorPreview,
  useIndicatorStore,
} from './store';

const ids = () => useIndicatorStore.getState().instances.map((i) => i.id);

beforeEach(() => {
  useIndicatorStore.setState({ instances: [] });
  useIndicatorPrefs.setState({ favorites: [], defaults: {} });
  useHistory.getState().clear();
  useIndicatorPreview.setState({ overrides: {} });
});

describe('timeframes and visibility', () => {
  it('resolves auto and drops timeframes at or below the chart interval', () => {
    expect(resolveTimeframe('auto', '5m')).toBe('1D');
    expect(resolveTimeframe('auto', '4h')).toBe('1D');
    expect(resolveTimeframe('auto', '1D')).toBe('1W');
    expect(resolveTimeframe('auto', '1W')).toBe('12M');
    expect(resolveTimeframe('auto', '12M')).toBe('');
    expect(resolveTimeframe('1h', '1D')).toBe('');
    expect(resolveTimeframe('1D', '1D')).toBe('');
    expect(resolveTimeframe('60m', '15m')).toBe('1h');
    expect(resolveTimeframe('', '1D')).toBe('');
  });

  it('checks per-interval visibility ranges', () => {
    const vis = defaultVisibility();
    vis.minutes = { enabled: true, min: 5, max: 30 };
    vis.days.enabled = false;
    expect(visibleOnInterval(null, '1m')).toBe(true);
    expect(visibleOnInterval(vis, '1m')).toBe(false);
    expect(visibleOnInterval(vis, '15m')).toBe(true);
    expect(visibleOnInterval(vis, '60m')).toBe(true); // counts as 1 hour
    expect(visibleOnInterval(vis, '1D')).toBe(false);
  });
});

describe('model', () => {
  it('builds legend titles, incl. indicator-on-indicator sources', () => {
    const sma = getIndicator('sma')!;
    const a = createInstance(sma, undefined, { length: 20 });
    expect(studyTitle(sma, a.inputs, () => undefined)).toBe('SMA 20 close');
    const b = createInstance(sma, undefined, { source: { instanceId: a.id, outputId: 'ma' } });
    expect(studyTitle(sma, b.inputs, (id) => (id === a.id ? a : undefined))).toBe('SMA 9 SMA: MA');
  });

  it('rejects source cycles and bad inputs', () => {
    const sma = getIndicator('sma')!;
    const a = createInstance(sma, undefined);
    const b = createInstance(sma, undefined, { source: { instanceId: a.id, outputId: 'ma' } });
    expect(validateInstances([a, b])).toBeNull();
    const cyc = { ...a, inputs: { ...a.inputs, source: { instanceId: b.id, outputId: 'ma' } } };
    expect(validateInstances([cyc, b])).toMatch(/cycle/);
    expect(validateInstances([{ ...a, inputs: { length: 'x' } }])).toMatch(/invalid/);
  });
});

describe('indicator actions', () => {
  it('adds with saved defaults and undoes/redoes', () => {
    useIndicatorPrefs.getState().saveDefaults('sma', {
      inputs: { length: 50 },
      styles: { ma: { colors: ['#ff0000'] } },
      visibility: null,
    });
    const id = addIndicator('sma')!;
    expect(findIndicator(id)?.inputs.length).toBe(50);
    expect(findIndicator(id)?.styles.ma?.colors).toEqual(['#ff0000']);
    useHistory.getState().undo();
    expect(ids()).toEqual([]);
    useHistory.getState().redo();
    expect(ids()).toEqual([id]);
  });

  it('removes and restores at the same position', () => {
    const a = addIndicator('sma')!;
    const b = addIndicator('ema')!;
    const c = addIndicator('sma')!;
    removeIndicator(b);
    expect(ids()).toEqual([a, c]);
    useHistory.getState().undo();
    expect(ids()).toEqual([a, b, c]);
  });

  it('validates, clamps and records updates', () => {
    const a = addIndicator('sma')!;
    const b = addIndicator('sma', { sourceOf: { instanceId: a, outputId: 'ma' } })!;
    expect(findIndicator(b)?.inputs.source).toEqual({ instanceId: a, outputId: 'ma' });
    // a -> b -> a would be a cycle: rejected, store unchanged.
    const before = findIndicator(a)!.inputs;
    expect(
      updateIndicator(a, { inputs: { ...before, source: { instanceId: b, outputId: 'ma' } } }, 'x'),
    ).toBe(false);
    expect(findIndicator(a)!.inputs).toEqual(before);
    // Clamped to the schema's max.
    expect(updateIndicator(a, { inputs: { ...before, length: 999_999 } }, 'x')).toBe(true);
    expect(findIndicator(a)!.inputs.length).toBe(5000);

    toggleIndicatorVisible(a);
    expect(findIndicator(a)!.visible).toBe(false);
    useHistory.getState().undo();
    expect(findIndicator(a)!.visible).toBe(true);
  });

  it('previews settings without touching the persisted store or the history', () => {
    const a = addIndicator('sma')!;
    const b = addIndicator('ema')!;
    const steps = () => useHistory.getState().past.length;
    const base = steps();
    expect(previewIndicator(a, { inputs: { ...findIndicator(a)!.inputs, length: 999_999 } })).toBe(
      true,
    );
    expect(previewIndicator(a, { visible: false })).toBe(true);
    // The chart sees the clamped preview; the store and the history do not.
    expect(effectiveInstances().find((i) => i.id === a)).toMatchObject({
      visible: false,
      inputs: { length: 5000 },
    });
    expect(findIndicator(a)).toMatchObject({ visible: true, inputs: { length: 9 } });
    expect(steps()).toBe(base);
    // Undo while previewing affects only the store (removes b), not the preview.
    useHistory.getState().undo();
    expect(ids()).toEqual([a]);
    expect(effectiveInstances()[0]!.inputs.length).toBe(5000);
    useHistory.getState().redo();
    expect(ids()).toEqual([a, b]);
    // Ok: one undo step.
    expect(commitPreview(a, 'Change SMA settings')).toBe(true);
    expect(useIndicatorPreview.getState().overrides).toEqual({});
    expect(findIndicator(a)).toMatchObject({ visible: false, inputs: { length: 5000 } });
    expect(steps()).toBe(base + 1);
    useHistory.getState().undo();
    expect(findIndicator(a)).toMatchObject({ visible: true, inputs: { length: 9 } });
    // Cancel: nothing persisted.
    previewIndicator(a, { visible: false });
    discardPreview(a);
    expect(effectiveInstances().find((i) => i.id === a)!.visible).toBe(true);
    expect(findIndicator(a)!.visible).toBe(true);
  });

  it('toggles favourites', () => {
    useIndicatorPrefs.getState().toggleFavorite('sma');
    expect(useIndicatorPrefs.getState().favorites).toEqual(['sma']);
    useIndicatorPrefs.getState().toggleFavorite('sma');
    expect(useIndicatorPrefs.getState().favorites).toEqual([]);
  });
});
