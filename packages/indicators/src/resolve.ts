import type { AnyIndicatorDefinition } from './registry';
import {
  PRICE_SOURCES,
  type ColorSpec,
  type InputValueMap,
  type InputValues,
  type InputsSchema,
  type OutputSourceRef,
  type OutputStyleOverrides,
  type PriceSource,
  type ResolvedOutput,
  type SourceValue,
} from './types';

export function isOutputRef(v: unknown): v is OutputSourceRef {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as OutputSourceRef).instanceId === 'string' &&
    typeof (v as OutputSourceRef).outputId === 'string'
  );
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
        if (typeof v !== 'string') throw bad();
        out[key] = v;
        break;
    }
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

/** Output references among the `source` inputs. */
export function sourceRefs(def: AnyIndicatorDefinition, inputs: InputValueMap): OutputSourceRef[] {
  const refs: OutputSourceRef[] = [];
  for (const [key, d] of Object.entries(def.inputs)) {
    const v = inputs[key] as SourceValue | undefined;
    if (d.kind === 'source' && isOutputRef(v)) refs.push(v);
  }
  return refs;
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
          textColor: ov.textColor ?? o.textColor ?? palette(o.color)[0] ?? '',
          offset: o.offset === undefined ? 0 : val(o.offset),
        };
    }
  });
}
