import type { IndicatorDefinition, InputsSchema } from './types';

/** Any definition, with its input/output types erased (registry storage). */
export type AnyIndicatorDefinition = IndicatorDefinition<InputsSchema, string>;

/**
 * Identity helper that infers literal input keys and output ids, so `step`
 * gets typed `ctx.src`, `ctx.inputs` and `ctx.set(id)`.
 */
export function defineIndicator<const S extends InputsSchema, const O extends string>(
  def: IndicatorDefinition<S, O>,
): IndicatorDefinition<S, O> {
  return def;
}

/** Lookup of definitions by id. The default registry holds the built-ins. */
export class IndicatorRegistry {
  private defs = new Map<string, AnyIndicatorDefinition>();

  register(def: AnyIndicatorDefinition): void {
    if (this.defs.has(def.id)) throw new Error(`Indicator "${def.id}" is already registered`);
    validateDefinition(def);
    this.defs.set(def.id, def);
  }

  /** Removes a definition (user script deleted or replaced). False if it was not registered. */
  unregister(id: string): boolean {
    return this.defs.delete(id);
  }

  get(id: string): AnyIndicatorDefinition | undefined {
    return this.defs.get(id);
  }

  list(): AnyIndicatorDefinition[] {
    return [...this.defs.values()];
  }
}

export const defaultRegistry = new IndicatorRegistry();

export function registerIndicator(def: AnyIndicatorDefinition): void {
  defaultRegistry.register(def);
}

export function getIndicator(id: string): AnyIndicatorDefinition | undefined {
  return defaultRegistry.get(id);
}

export function listIndicators(): AnyIndicatorDefinition[] {
  return defaultRegistry.list();
}

/** Structural checks that TypeScript cannot express. Throws on the first problem. */
export function validateDefinition(def: AnyIndicatorDefinition): void {
  const ids = new Set<string>();
  for (const o of def.outputs) {
    if (ids.has(o.id)) throw new Error(`${def.id}: duplicate output id "${o.id}"`);
    ids.add(o.id);
  }
  for (const o of def.outputs) {
    if (o.type !== 'fill') continue;
    for (const ref of o.between) {
      const target = def.outputs.find((x) => x.id === ref);
      if (!target || (target.type !== 'plot' && target.type !== 'hline'))
        throw new Error(`${def.id}: fill "${o.id}" must reference plots or hlines, got "${ref}"`);
    }
  }
  const tfInputs = Object.values(def.inputs).filter((i) => i.kind === 'timeframe');
  if (tfInputs.length > 1) throw new Error(`${def.id}: at most one timeframe input is allowed`);
  if (def.repaints && tfInputs.length)
    throw new Error(`${def.id}: repainting indicators cannot have a timeframe input`);
  for (const [key, input] of Object.entries(def.inputs)) {
    if (input.kind === 'enum' && !input.options.includes(input.default))
      throw new Error(`${def.id}: enum input "${key}" default is not an option`);
  }
}
