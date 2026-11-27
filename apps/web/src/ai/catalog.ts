/**
 * What the AI may add and draw beyond the curated Basic set (Standard and Full tiers): a search
 * over the indicator registry, validation of indicator inputs the model sends, and the drawing
 * types it may place from anchor points. Pure helpers; the tools in `tools.ts` use them.
 */
import { getDrawingTool, listDrawingTools } from '@tickerglass/engine';
import {
  getIndicator,
  listIndicators,
  type AnyIndicatorDefinition,
  type InputDef,
} from '@tickerglass/indicators';
import type { AiTier } from './api';

const SEARCH_LIMIT = 8;

/** Drawing types a Standard model may place: common analysis tools that need only anchors. */
export const STANDARD_DRAWINGS = [
  'trend-line',
  'ray',
  'extended-line',
  'horizontal-ray',
  'vertical-line',
  'arrow-line',
  'rectangle',
  'parallel-channel',
  'fib-retracement',
  'fib-extension',
  'fib-time-zone',
  'text',
  'callout',
] as const;

/** How many anchors a drawing type takes, or null when it cannot be placed from points. */
export function anchorRange(type: string): { min: number; max: number } | null {
  const def = getDrawingTool(type);
  if (!def) return null;
  const c = def.creation;
  switch (c.kind) {
    case 'click':
      return { min: 1, max: 1 };
    case 'points':
      return { min: c.count, max: c.count };
    case 'multi':
      return { min: c.min, max: c.max ?? 50 };
    default:
      return null; // freehand
  }
}

/** Drawing types a model of `tier` may place (registered ones only). */
export function drawableTypes(tier: AiTier): string[] {
  if (tier === 'full')
    return listDrawingTools()
      .map((d) => d.type)
      .filter((t) => anchorRange(t) !== null && (getDrawingTool(t)?.coords ?? 'chart') === 'chart');
  return STANDARD_DRAWINGS.filter((t) => anchorRange(t) !== null);
}

/** What the model reads about one input. */
function describeInput(def: InputDef): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: def.kind, default: def.default };
  if (def.label) out.label = def.label;
  if ('options' in def) out.options = def.options;
  if ('min' in def && def.min !== undefined) out.min = def.min;
  if ('max' in def && def.max !== undefined) out.max = def.max;
  return out;
}

/** Inputs the model may set: no colours (style belongs to the user). */
function settableInputs(def: AnyIndicatorDefinition): [string, InputDef][] {
  return Object.entries(def.inputs as Record<string, InputDef>).filter(
    ([, d]) => d.kind !== 'color',
  );
}

export function describeIndicator(def: AnyIndicatorDefinition): Record<string, unknown> {
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    pane: def.overlay ? 'price' : 'own pane',
    inputs: Object.fromEntries(settableInputs(def).map(([k, d]) => [k, describeInput(d)])),
  };
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Indicators matching `query` (id, name, short name, keywords), best first. */
export function searchIndicators(query: string): AnyIndicatorDefinition[] {
  const q = norm(query);
  if (!q) return [];
  const words = q.split(' ');
  const scored = listIndicators()
    .map((def) => {
      const id = norm(def.id);
      const name = norm(def.name);
      const short = norm(def.shortName);
      const keys = (def.keywords ?? []).map(norm);
      let score = 0;
      if (id === q || short === q || name === q) score += 100;
      if (keys.includes(q)) score += 60;
      if (name.startsWith(q) || short.startsWith(q)) score += 30;
      const hay = [id, name, short, ...keys].join(' ');
      for (const w of words) if (hay.includes(w)) score += 10;
      if (words.every((w) => hay.includes(w))) score += 20;
      return { def, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, SEARCH_LIMIT).map((x) => x.def);
}

/** A registry indicator by id, or by an exact name / short name the model used. */
export function findIndicatorDef(nameOrId: string): AnyIndicatorDefinition | undefined {
  const direct = getIndicator(nameOrId);
  if (direct) return direct;
  const q = norm(nameOrId);
  return listIndicators().find(
    (d) => norm(d.id) === q || norm(d.name) === q || norm(d.shortName) === q,
  );
}

/**
 * The model's `inputs` checked against the definition: unknown keys and bad values are reported,
 * numbers are clamped and rounded, enum values matched case-insensitively.
 */
export function coerceInputs(
  def: AnyIndicatorDefinition,
  raw: unknown,
): { inputs: Record<string, unknown>; errors: string[] } {
  const inputs: Record<string, unknown> = {};
  const errors: string[] = [];
  if (raw === undefined || raw === null) return { inputs, errors };
  if (typeof raw !== 'object' || Array.isArray(raw))
    return { inputs, errors: ['inputs must be an object'] };
  const defs = Object.fromEntries(settableInputs(def));
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const d = defs[key];
    if (!d) {
      errors.push(`unknown input "${key}" (inputs: ${Object.keys(defs).join(', ') || 'none'})`);
      continue;
    }
    switch (d.kind) {
      case 'int':
      case 'float':
      case 'time': {
        let n = typeof value === 'number' ? value : Number(String(value).trim());
        if (!Number.isFinite(n)) {
          errors.push(`${key} must be a number`);
          break;
        }
        if (d.kind === 'int') n = Math.round(n);
        if ('min' in d && d.min !== undefined) n = Math.max(d.min, n);
        if ('max' in d && d.max !== undefined) n = Math.min(d.max, n);
        inputs[key] = n;
        break;
      }
      case 'bool':
        inputs[key] = value === true || value === 'true' || value === 1;
        break;
      case 'enum': {
        const hit = d.options.find((o) => o.toLowerCase() === String(value).toLowerCase());
        if (hit === undefined) errors.push(`${key} must be one of ${d.options.join(', ')}`);
        else inputs[key] = hit;
        break;
      }
      default:
        if (typeof value !== 'string' || !value.trim()) errors.push(`${key} must be a string`);
        else inputs[key] = value.trim();
    }
  }
  return { inputs, errors };
}
