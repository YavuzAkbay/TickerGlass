// App-side indicator model: persisted instance state, interval visibility,
// timeframe resolution, legend titles and validation. Pure (no DOM, no stores).
import {
  formatInterval,
  intervalSeconds,
  isIntraday,
  parseInterval,
  type Interval,
} from '@investopen/engine';
import {
  EXTERNAL_SOURCE_PREFIX,
  coerceInputs,
  externalRefSymbol,
  externalSymbols,
  getIndicator,
  isExternalRef,
  isOutputRef,
  isUserScriptType,
  resolveInputs,
  sourceRefs,
  timeframeInputValue,
  VOLUME,
  type AnyIndicatorDefinition,
  type InputValueMap,
  type OutputSourceRef,
  type OutputStyleOverrides,
  type PriceSource,
} from '@investopen/indicators';

// ------------------------------------------------------------- visibility

export type VisibilityUnit = 'seconds' | 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

export interface VisibilityRange {
  enabled: boolean;
  min: number;
  max: number;
}

export type IntervalVisibility = Record<VisibilityUnit, VisibilityRange>;

export const VISIBILITY_UNITS: { unit: VisibilityUnit; label: string; limit: [number, number] }[] =
  [
    { unit: 'seconds', label: 'Seconds', limit: [1, 59] },
    { unit: 'minutes', label: 'Minutes', limit: [1, 59] },
    { unit: 'hours', label: 'Hours', limit: [1, 24] },
    { unit: 'days', label: 'Days', limit: [1, 366] },
    { unit: 'weeks', label: 'Weeks', limit: [1, 52] },
    { unit: 'months', label: 'Months', limit: [1, 12] },
  ];

export function defaultVisibility(): IntervalVisibility {
  const out = {} as IntervalVisibility;
  for (const { unit, limit } of VISIBILITY_UNITS)
    out[unit] = { enabled: true, min: limit[0], max: limit[1] };
  return out;
}

const UNIT_TO_VIS: Record<Interval['unit'], VisibilityUnit> = {
  minute: 'minutes',
  hour: 'hours',
  day: 'days',
  week: 'weeks',
  month: 'months',
};

function tryParse(s: string): Interval | null {
  try {
    return parseInterval(s);
  } catch {
    return null;
  }
}

/** Whether an instance with `vis` is shown on `interval` (null = everywhere). */
export function visibleOnInterval(vis: IntervalVisibility | null, interval: string): boolean {
  if (!vis) return true;
  const iv = tryParse(interval);
  if (!iv) return true;
  // "60m" counts as 1 hour, like the interval menu.
  const n =
    iv.unit === 'minute' && iv.count % 60 === 0
      ? { unit: 'hour' as const, count: iv.count / 60 }
      : iv;
  const r = vis[UNIT_TO_VIS[n.unit]];
  return r.enabled && n.count >= r.min && n.count <= r.max;
}

// ------------------------------------------------------------- timeframes

/**
 * Series a timeframe input value runs on for a chart interval ('' = chart bars).
 * 'auto' (Pivot Points): intraday -> 1D, days -> 1W, longer -> 12M. A
 * timeframe equal to or below the chart interval computes on chart bars.
 */
export function resolveTimeframe(tf: string, chartInterval: string): string {
  if (!tf) return '';
  const chart = tryParse(chartInterval);
  if (!chart) return '';
  let target = tf;
  if (tf === 'auto') target = isIntraday(chart) ? '1D' : chart.unit === 'day' ? '1W' : '12M';
  const t = tryParse(target);
  if (!t) return '';
  return intervalSeconds(t) <= intervalSeconds(chart) ? '' : formatInterval(t);
}

/** Map for the worker's `timeframeMap` message: every raw tf value in use. */
export function timeframeMap(
  instances: readonly { type: string; inputs: InputValueMap }[],
  chartInterval: string,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const inst of instances) {
    const def = getIndicator(inst.type);
    if (!def) continue;
    const raw = timeframeInputValue(def, inst.inputs);
    if (raw) map[raw] = resolveTimeframe(raw, chartInterval);
  }
  return map;
}

// --------------------------------------------------------------- instances

/** Where the study is drawn. 'auto': price pane for overlays, own pane otherwise
 * (or the source study's pane for indicator-on-indicator). */
export type Placement = 'auto' | 'main' | 'own';

/** One indicator on the chart, as persisted. Array order = legend/add order. */
export interface IndicatorState {
  id: string;
  type: string;
  inputs: InputValueMap;
  styles: OutputStyleOverrides;
  visible: boolean;
  /** Per-interval visibility; null = all intervals. */
  visibility: IntervalVisibility | null;
  placement: Placement;
}

/** User "Save as default" for an indicator type. */
export interface IndicatorDefaults {
  inputs: InputValueMap;
  styles: OutputStyleOverrides;
  visibility: IntervalVisibility | null;
}

let seq = 0;

/** Unique per chart, never 'main'/'volume*'. */
export function newInstanceId(type: string): string {
  seq = (seq + 1) % 1e6;
  // User script types contain ':' (registry id `user:<scriptId>`).
  return `${type.replace(/[^A-Za-z0-9_-]/g, '_')}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function createInstance(
  def: AnyIndicatorDefinition,
  defaults: IndicatorDefaults | undefined,
  inputs: InputValueMap = {},
): IndicatorState {
  return {
    id: newInstanceId(def.id),
    type: def.id,
    inputs: resolveInputs(def, { ...(defaults?.inputs ?? {}), ...inputs }),
    styles: structuredClone(defaults?.styles ?? {}),
    visible: true,
    visibility: defaults?.visibility ? structuredClone(defaults.visibility) : null,
    placement: 'auto',
  };
}

/** Id of the Volume instance of a new chart (and of migrated built-in volume). */
export const DEFAULT_VOLUME_ID = 'volume_default';

/**
 * The Volume indicator as a new chart shows it: columns at the bottom of the
 * price pane on their own scale ('main'), or in a pane of its own ('own').
 */
export function defaultVolumeInstance(placement: Placement = 'main'): IndicatorState {
  return { ...createInstance(VOLUME, undefined), id: DEFAULT_VOLUME_ID, placement };
}

/**
 * `list` with the Volume indicator that replaces the engine's built-in volume
 * of older saved state (`mode`: 'overlay' -> price pane, 'pane' -> own pane).
 * Idempotent: unchanged when `mode` is 'hidden'/unknown or a Volume
 * indicator is already there (never two volume displays).
 */
export function withLegacyVolume<T extends { type: string }>(
  list: readonly T[],
  mode: unknown,
): (T | IndicatorState)[] {
  if ((mode !== 'overlay' && mode !== 'pane') || list.some((i) => i.type === VOLUME.id))
    return [...list];
  return [defaultVolumeInstance(mode === 'pane' ? 'own' : 'main'), ...list];
}

/** Key of the definition's first `source` input, if any. */
export function sourceInputKey(def: AnyIndicatorDefinition): string | null {
  for (const [k, d] of Object.entries(def.inputs)) if (d.kind === 'source') return k;
  return null;
}

/** The instance whose output `inst` reads through its first source input, if any. */
export function sourceRefOf(inst: IndicatorState): OutputSourceRef | null {
  const def = getIndicator(inst.type);
  const key = def ? sourceInputKey(def) : null;
  const v = key ? inst.inputs[key] : undefined;
  return isOutputRef(v) && !isExternalRef(v) ? v : null;
}

/**
 * Check a candidate instance list before committing it to the store (the worker
 * would reject the same problems asynchronously). Returns an error message or null.
 */
export function validateInstances(list: readonly IndicatorState[]): string | null {
  const byId = new Map(list.map((i) => [i.id, i]));
  const deps = new Map<string, string[]>();
  for (const inst of list) {
    const def = getIndicator(inst.type);
    if (!def) return `Unknown indicator "${inst.type}"`;
    const user = isUserScriptType(inst.type);
    // Scripts and built-ins never read each other's outputs (checked on the stored refs).
    for (const r of sourceRefs(def, inst.inputs)) {
      const target = byId.get(r.instanceId);
      if (target && isUserScriptType(target.type) !== user)
        return 'Scripts and built-in indicators cannot use each other as sources';
    }
    let inputs = inst.inputs;
    if (user) {
      // Stored inputs of a script that may have changed since: never an error.
      inputs = coerceInputs(def, inst.inputs);
    } else {
      try {
        resolveInputs(def, inst.inputs);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }
    const refs = sourceRefs(def, inputs);
    if ((refs.length || externalSymbols(def, inputs).length) && timeframeInputValue(def, inputs))
      return 'Indicators on another timeframe can only use price sources';
    deps.set(
      inst.id,
      refs.map((r) => r.instanceId).filter((id) => byId.has(id)),
    );
  }
  const state = new Map<string, 1 | 2>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 2) return true;
    if (state.get(id) === 1) return false;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (!visit(d)) return false;
    state.set(id, 2);
    return true;
  };
  for (const inst of list) if (!visit(inst.id)) return 'Indicator sources would form a cycle';
  return null;
}

/** Ids of instances that (transitively) read `id`'s outputs. */
export function dependentsOf(list: readonly IndicatorState[], id: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const inst of list) {
      if (out.has(inst.id) || inst.id === id) continue;
      const def = getIndicator(inst.type);
      if (!def) continue;
      if (sourceRefs(def, inst.inputs).some((r) => r.instanceId === id || out.has(r.instanceId))) {
        out.add(inst.id);
        grew = true;
      }
    }
  }
  return out;
}

// ----------------------------------------------------------------- titles

/** Price source names for menus and the settings dialog. */
export const SOURCE_LABELS: Record<PriceSource, string> = {
  open: 'Open',
  high: 'High',
  low: 'Low',
  close: 'Close',
  volume: 'Volume',
  hl2: '(H + L)/2',
  hlc3: '(H + L + C)/3',
  ohlc4: '(O + H + L + C)/4',
  hlcc4: '(H + L + C + C)/4',
};

/** Lookup used to name indicator-on-indicator sources ("SMA: MA"). */
export type InstanceLookup = (id: string) => IndicatorState | undefined;

export function outputRefLabel(ref: OutputSourceRef, lookup: InstanceLookup): string {
  if (ref.instanceId.startsWith(EXTERNAL_SOURCE_PREFIX))
    return `${externalRefSymbol(ref)}: ${SOURCE_LABELS[ref.outputId as PriceSource] ?? ref.outputId}`;
  const inst = lookup(ref.instanceId);
  const def = inst ? getIndicator(inst.type) : undefined;
  if (!def) return 'removed source';
  const out = def.outputs.find((o) => o.id === ref.outputId);
  return `${def.shortName}: ${out?.title ?? ref.outputId}`;
}

/** Short inputs string for the legend, e.g. "14 close". */
export function inputsTitle(
  def: AnyIndicatorDefinition,
  inputs: InputValueMap,
  lookup: InstanceLookup,
): string {
  const parts: string[] = [];
  for (const [key, d] of Object.entries(def.inputs)) {
    if (d.hideInTitle) continue;
    const v = inputs[key];
    if (v === undefined) continue;
    switch (d.kind) {
      case 'int':
      case 'float':
        parts.push(String(v));
        break;
      case 'source':
        parts.push(isOutputRef(v) ? outputRefLabel(v, lookup) : String(v));
        break;
      case 'enum':
        parts.push(d.optionLabels?.[v as string] ?? String(v));
        break;
      case 'symbol':
        if (v) parts.push(String(v));
        break;
      case 'timeframe':
        if (v) parts.push(v === 'auto' ? 'Auto' : String(v));
        break;
      case 'time':
        if (typeof v === 'number' && v > 0)
          parts.push(new Date(v * 1000).toISOString().slice(0, 16).replace('T', ' '));
        break;
      case 'bool':
      case 'color':
        break;
    }
  }
  return parts.join(' ');
}

/** Full study title, e.g. "RSI 14 close". */
export function studyTitle(
  def: AnyIndicatorDefinition,
  inputs: InputValueMap,
  lookup: InstanceLookup,
): string {
  const rest = inputsTitle(def, inputs, lookup);
  return rest ? `${def.shortName} ${rest}` : def.shortName;
}
