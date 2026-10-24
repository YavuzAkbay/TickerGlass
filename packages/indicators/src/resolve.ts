import type { AnyIndicatorDefinition } from './registry';
import {
  EXTERNAL_SOURCE_PREFIX,
  PRICE_SOURCES,
  VOLUME_PROFILE_COLOR_KEYS,
  type ColorSpec,
  type InputValueMap,
  type InputValues,
  type InputsSchema,
  type OutputDef,
  type OutputSourceRef,
  type OutputStyleOverrides,
  type PriceSource,
  type ResolvedOutput,
  type SourceValue,
} from './types';
import { isSafeColor, isUserScriptType } from './user-script';

export function isOutputRef(v: unknown): v is OutputSourceRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as OutputSourceRef).instanceId === 'string' &&
    typeof (v as OutputSourceRef).outputId === 'string'
  );
}

/** A source ref to an external symbol's price column (`sym:<SYMBOL>`), not an instance. */
export function isExternalRef(v: unknown): v is OutputSourceRef {
  return isOutputRef(v) && v.instanceId.startsWith(EXTERNAL_SOURCE_PREFIX);
}

export function isPriceSource(v: unknown): v is PriceSource {
  return typeof v === 'string' && (PRICE_SOURCES as readonly string[]).includes(v);
}

/**
 * Defaults filled in, numbers clamped to min/max (ints rounded). Unknown keys
 * are dropped. Throws on a value of the wrong type.
 */
export function resolveInputs(
  def: AnyIndicatorDefinition,
  given: InputValueMap = {},
): InputValueMap {
  const out: InputValueMap = {};
  for (const [key, d] of Object.entries(def.inputs)) {
    const v = given[key];
    if (v === undefined) {
      out[key] = d.default;
      continue;
    }
    const bad = () => new TypeError(`${def.id}: invalid value for input "${key}"`);
    switch (d.kind) {
      case 'int':
      case 'float': {
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad();
        let x = d.kind === 'int' ? Math.round(v) : v;
        if (d.min !== undefined) x = Math.max(d.min, x);
        if (d.max !== undefined) x = Math.min(d.max, x);
        out[key] = x;
        break;
      }
      case 'time':
        if (typeof v !== 'number' || !Number.isFinite(v)) throw bad();
        out[key] = v;
        break;
      case 'bool':
        if (typeof v !== 'boolean') throw bad();
        out[key] = v;
        break;
      case 'source':
        if (!isPriceSource(v) && !isOutputRef(v)) throw bad();
        out[key] = isOutputRef(v) ? { instanceId: v.instanceId, outputId: v.outputId } : v;
        break;
      case 'enum':
        if (typeof v !== 'string' || !d.options.includes(v)) throw bad();
        out[key] = v;
        break;
      case 'color':
      case 'timeframe':
      case 'symbol':
        if (typeof v !== 'string') throw bad();
        out[key] = v;
        break;
    }
  }
  return out;
}

/**
 * Like `resolveInputs` but never throws: a missing or invalid value falls back
 * to the input's default; valid values are kept (clamped/rounded the same
 * way); unknown keys are dropped. For user script types (`user:`) `source`
 * inputs accept only price sources and `color` inputs only safe colours. For
 * stored inputs of definitions that may have changed since (user scripts).
 */
export function coerceInputs(
  def: AnyIndicatorDefinition,
  given: InputValueMap = {},
): InputValueMap {
  const user = isUserScriptType(def.id);
  const out: InputValueMap = {};
  for (const [key, d] of Object.entries(def.inputs)) {
    const v = Object.hasOwn(given, key) ? given[key] : undefined;
    let ok = v !== undefined;
    if (ok && user && d.kind === 'source') ok = isPriceSource(v);
    if (ok && user && d.kind === 'color') ok = isSafeColor(v);
    if (ok) {
      try {
        const r = resolveInputs(def, { [key]: v } as InputValueMap)[key];
        if (r !== undefined) {
          out[key] = r;
          continue;
        }
      } catch {
        // Wrong type for this input: use the default below.
      }
    }
    out[key] = d.default;
  }
  return out;
}

/** The raw value of the definition's timeframe input ('' if none / chart). */
export function timeframeInputValue(def: AnyIndicatorDefinition, inputs: InputValueMap): string {
  for (const [key, d] of Object.entries(def.inputs)) {
    if (d.kind === 'timeframe') {
      const v = inputs[key];
      return typeof v === 'string' ? v : '';
    }
  }
  return '';
}

/** Whether an instance with these (resolved) inputs reads `env.events` (`def.usesEvents`). */
export function usesEvents(def: AnyIndicatorDefinition, inputs: InputValueMap): boolean {
  const u = def.usesEvents;
  return typeof u === 'function' ? u(inputs as InputValues<InputsSchema>) : u === true;
}

/** Whether an instance with these (resolved) inputs reads `env.fundamentals` (`def.usesFundamentals`). */
export function usesFundamentals(def: AnyIndicatorDefinition, inputs: InputValueMap): boolean {
  const u = def.usesFundamentals;
  return typeof u === 'function' ? u(inputs as InputValues<InputsSchema>) : u === true;
}

/**
 * Whether a timeframe instance aligns to confirmed (closed) timeframe bars:
 * the timeframe input's `waitForCloseInput` bool is true.
 */
export function waitsForTimeframeClose(
  def: AnyIndicatorDefinition,
  inputs: InputValueMap,
): boolean {
  for (const d of Object.values(def.inputs)) {
    if (d.kind !== 'timeframe') continue;
    return d.waitForCloseInput !== undefined && inputs[d.waitForCloseInput] === true;
  }
  return false;
}

/** Output references to other instances among the `source` inputs (not external symbols). */
export function sourceRefs(def: AnyIndicatorDefinition, inputs: InputValueMap): OutputSourceRef[] {
  const refs: OutputSourceRef[] = [];
  for (const [key, d] of Object.entries(def.inputs)) {
    const v = inputs[key] as SourceValue | undefined;
    if (d.kind === 'source' && isOutputRef(v) && !isExternalRef(v)) refs.push(v);
  }
  return refs;
}

/** Symbol of an external source ref (`sym:GOOG` -> 'GOOG'). */
export function externalRefSymbol(ref: OutputSourceRef): string {
  return ref.instanceId.slice(EXTERNAL_SOURCE_PREFIX.length);
}

/**
 * External symbols an instance needs: `symbol` inputs (non-empty) and `sym:`
 * source refs. Unique, in input order.
 */
export function externalSymbols(def: AnyIndicatorDefinition, inputs: InputValueMap): string[] {
  const out = new Set<string>();
  for (const [key, d] of Object.entries(def.inputs)) {
    const v = inputs[key];
    if (d.kind === 'symbol' && typeof v === 'string' && v !== '') out.add(v);
    else if (d.kind === 'source' && isExternalRef(v)) out.add(externalRefSymbol(v));
  }
  return [...out];
}

/** Outputs with a per-bar values array: plots, shapes, background, volume profile period marks. */
export function isValueOutput(o: OutputDef): boolean {
  return (
    o.type === 'plot' || o.type === 'shape' || o.type === 'bgcolor' || o.type === 'volumeProfile'
  );
}

function palette(c: ColorSpec): string[] {
  return typeof c === 'string' ? [c] : [...c];
}

/**
 * Concrete output metadata for drawing: input-dependent values (hline levels,
 * plot offsets) evaluated, defaults applied, then user overrides.
 * Structurally identical to the engine's StudyOutputMeta.
 */
export function resolveOutputs(
  def: AnyIndicatorDefinition,
  inputs: InputValueMap,
  overrides: OutputStyleOverrides = {},
): ResolvedOutput[] {
  const typed = inputs as InputValues<InputsSchema>;
  const val = <T>(v: T | ((i: InputValues<InputsSchema>) => T)): T =>
    typeof v === 'function' ? (v as (i: InputValues<InputsSchema>) => T)(typed) : v;
  return def.outputs.map((o): ResolvedOutput => {
    const ov = overrides[o.id] ?? {};
    const visible = ov.visible ?? o.visible ?? true;
    switch (o.type) {
      case 'plot':
        return {
          type: 'plot',
          id: o.id,
          title: o.title,
          visible,
          kind: ov.kind ?? o.kind,
          colors: ov.colors ?? palette(o.color),
          lineWidth: ov.lineWidth ?? o.lineWidth ?? 1,
          lineStyle: ov.lineStyle ?? o.lineStyle ?? 'solid',
          base: o.base === undefined ? 0 : o.base,
          offset: o.offset === undefined ? 0 : val(o.offset),
          showLastValue: o.showLastValue ?? true,
          connectGaps: o.connectGaps ?? false,
        };
      case 'hline':
        return {
          type: 'hline',
          id: o.id,
          title: o.title,
          visible,
          value: val(o.value),
          color: ov.color ?? o.color,
          lineWidth: ov.lineWidth ?? o.lineWidth ?? 1,
          lineStyle: ov.lineStyle ?? o.lineStyle ?? 'dashed',
        };
      case 'fill':
        return {
          type: 'fill',
          id: o.id,
          title: o.title,
          visible,
          between: [o.between[0], o.between[1]],
          colors: ov.colors ?? palette(o.color),
        };
      case 'bgcolor':
        return {
          type: 'bgcolor',
          id: o.id,
          title: o.title,
          visible,
          colors: ov.colors ?? palette(o.color),
          offset: o.offset === undefined ? 0 : val(o.offset),
        };
      case 'shape':
        return {
          type: 'shape',
          id: o.id,
          title: o.title,
          visible,
          shape: o.shape,
          location: o.location,
          size: ov.size ?? o.size ?? 'small',
          colors: ov.colors ?? palette(o.color),
          text: o.text ?? '',
          textFromValue: o.textFromValue ?? false,
          textColor: ov.textColor ?? o.textColor ?? palette(o.color)[0] ?? '',
          offset: o.offset === undefined ? 0 : val(o.offset),
        };
      case 'volumeProfile':
        return {
          type: 'volumeProfile',
          id: o.id,
          title: o.title,
          visible,
          mode: o.mode,
          rowsLayout: val(o.rowsLayout),
          rows: val(o.rows),
          rowSize: val(o.rowSize),
          valueArea: val(o.valueArea),
          widthPercent: val(o.widthPercent),
          placement: val(o.placement),
          colors: ov.colors ?? VOLUME_PROFILE_COLOR_KEYS.map((k) => o[k]),
        };
    }
  });
}
