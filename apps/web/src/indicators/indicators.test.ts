import {
  defaultRegistry,
  defineIndicator,
  getIndicator,
  type AnyIndicatorDefinition,
} from '@tickerglass/indicators';
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
  newInstanceId,
  outputRefLabel,
  sourceRefOf,
  resolveTimeframe,
  studyTitle,
  validateInstances,
  visibleOnInterval,
} from './model';
import { useCompareStore } from '../compare/store';
import { useUiStore } from '../store/ui';
import { indicatorMenuItems, overlayOption, overlaySymbols, sourceOptions } from './menu';
import { firstOutputId } from '../alerts/dialog/sources';
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

describe('external symbol sources', () => {
  const ref = { instanceId: 'sym:GOOG', outputId: 'close' };

  it('labels and titles overlay sources, and they are not instance dependencies', () => {
    expect(outputRefLabel(ref, () => undefined)).toBe('GOOG: Close');
    const ma = createInstance(getIndicator('sma')!, undefined, { source: ref });
    expect(studyTitle(getIndicator('sma')!, ma.inputs, () => undefined)).toBe('SMA 9 GOOG: Close');
    expect(sourceRefOf(ma)).toBeNull();
    expect(validateInstances([ma])).toBeNull();
    const cc = createInstance(getIndicator('correlation')!, undefined, { symbol: 'MSFT' });
    expect(studyTitle(getIndicator('correlation')!, cc.inputs, () => undefined)).toBe(
      'CC MSFT close 20',
    );
  });

  it('lists compare symbols in the Overlays group', () => {
    useCompareStore.setState({
      items: [
        {
          id: 'cmp-1',
          symbol: 'MSFT',
          placement: 'same',
          visible: true,
          color: '#fff',
          lineWidth: 2,
        },
      ],
    });
    expect(overlaySymbols()).toEqual(['MSFT']);
    const sma = createInstance(getIndicator('sma')!, undefined);
    const opts = sourceOptions(sma, [sma], overlaySymbols());
    expect(opts.filter((o) => o.group === 'Overlays').map((o) => o.label)).toEqual([
      'MSFT: Close',
      'MSFT: Open',
      'MSFT: High',
      'MSFT: Low',
    ]);
    expect(overlayOption('MSFT', 'close').value).toEqual({
      instanceId: 'sym:MSFT',
      outputId: 'close',
    });
    useCompareStore.setState({ items: [] });
  });
});

describe('user script isolation', () => {
  const UT = 'user:iso-test';
  const userDef = (): AnyIndicatorDefinition =>
    defineIndicator({
      id: UT,
      name: 'Iso',
      shortName: 'ISO',
      category: 'other',
      overlay: true,
      inputs: {
        length: { kind: 'int', label: 'Length', default: 10, min: 1, max: 50 },
        source: { kind: 'source', label: 'Source', default: 'close' },
      },
      outputs: [{ type: 'plot', id: 'v', title: 'V', kind: 'line', color: '#fff' }],
      setup: () => () => {},
    });

  beforeEach(() => {
    defaultRegistry.unregister(UT);
    defaultRegistry.register(userDef());
  });

  it('newInstanceId sanitises the type and leaves builtin ids alone', () => {
    expect(newInstanceId(UT)).toMatch(/^user_iso-test_[0-9a-z]+$/);
    expect(newInstanceId('sma')).toMatch(/^sma_[0-9a-z]+$/);
    expect(newInstanceId('bollinger_bands')).toMatch(/^bollinger_bands_/);
    // Every registered builtin id is already within [A-Za-z0-9_-].
    for (const d of defaultRegistry.list())
      if (!d.id.startsWith('user:')) expect(d.id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('validateInstances coerces script inputs and rejects cross references', () => {
    const sma = createInstance(getIndicator('sma')!, undefined);
    const u = createInstance(getIndicator(UT)!, undefined);
    expect(validateInstances([sma, u])).toBeNull();
    expect(validateInstances([{ ...u, inputs: { length: 'x', gone: 1 } }])).toBeNull();
    const userOnBuiltin = {
      ...u,
      inputs: { ...u.inputs, source: { instanceId: sma.id, outputId: 'ma' } },
    };
    expect(validateInstances([sma, userOnBuiltin])).toMatch(/cannot use each other/);
    const builtinOnUser = {
      ...sma,
      inputs: { ...sma.inputs, source: { instanceId: u.id, outputId: 'v' } },
    };
    expect(validateInstances([u, builtinOnUser])).toMatch(/cannot use each other/);
  });

  it('sourceOptions: scripts get price sources only, builtins never see scripts', () => {
    const sma = createInstance(getIndicator('sma')!, undefined);
    const u = createInstance(getIndicator(UT)!, undefined);
    const forUser = sourceOptions(u, [sma, u], ['GOOG']);
    expect(forUser.every((o) => typeof o.value === 'string')).toBe(true);
    const forBuiltin = sourceOptions(sma, [sma, u], []);
    expect(forBuiltin.some((o) => typeof o.value !== 'string')).toBe(false);
  });

  it('legend menu disables alerts and indicator-on for scripts', () => {
    const u = createInstance(getIndicator(UT)!, undefined);
    useIndicatorStore.setState({ instances: [u] });
    const items = indicatorMenuItems(u.id);
    for (const label of ['Add alert…', 'Add indicator on ISO…']) {
      const it = items.find((i) => 'label' in i && i.label === label);
      expect(it).toMatchObject({ disabled: true });
      expect((it as { title?: string }).title).toBeTruthy();
    }
  });

  it('legend menu offers "Edit script…" for scripts only, opening the editor on it', () => {
    const u = createInstance(getIndicator(UT)!, undefined);
    const sma = createInstance(getIndicator('sma')!, undefined);
    useIndicatorStore.setState({ instances: [u, sma] });
    const label = (id: string) =>
      indicatorMenuItems(id).find((i) => 'label' in i && i.label === 'Edit script…');
    expect(label(sma.id)).toBeUndefined();
    (label(u.id) as { onSelect: () => void }).onSelect();
    expect(useUiStore.getState()).toMatchObject({
      dialog: 'scriptEditor',
      dialogArg: { scriptId: 'iso-test' },
    });
    useUiStore.getState().closeDialog();
  });

  it('alert sources skip scripts', () => {
    expect(firstOutputId(UT)).toBeNull();
    expect(firstOutputId('sma')).toBe('ma');
  });
});
