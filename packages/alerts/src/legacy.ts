/**
 * Alert specs saved before an indicator was renamed carry its old id in
 * `instances[].type`. `upgradeAlertSpec` maps those through
 * `resolveIndicatorId`; anything that is not a recognisable spec is returned
 * untouched so validation still reports it.
 */
import { resolveIndicatorId } from '@investopen/indicators';

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function upgradeOperand(op: unknown): unknown {
  if (!isObj(op)) return op;
  if (op['kind'] === 'indicator' && isObj(op['ref']) && Array.isArray(op['ref']['instances'])) {
    const ref = op['ref'];
    const instances = (ref['instances'] as unknown[]).map((inst) =>
      isObj(inst) && typeof inst['type'] === 'string'
        ? { ...inst, type: resolveIndicatorId(inst['type']) }
        : inst,
    );
    return { ...op, ref: { ...ref, instances } };
  }
  if (op['kind'] === 'bounds') {
    return { ...op, upper: upgradeOperand(op['upper']), lower: upgradeOperand(op['lower']) };
  }
  return op;
}

/** `spec` with legacy indicator ids replaced; returns the same value if it is not an object. */
export function upgradeAlertSpec<T>(spec: T): T {
  if (!isObj(spec)) return spec;
  const out: Json = { ...spec, left: upgradeOperand(spec['left']) };
  const cond = spec['condition'];
  if (isObj(cond)) {
    const c: Json = { ...cond };
    if ('right' in c) c['right'] = upgradeOperand(c['right']);
    if (isObj(c['channel'])) c['channel'] = upgradeOperand(c['channel']);
    out['condition'] = c;
  }
  return out as T;
}
