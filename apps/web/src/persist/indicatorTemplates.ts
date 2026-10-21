/**
 * Indicator templates: named sets of indicator instances (inputs, styles,
 * visibility) stored in `/indicator-templates`. Applying one creates fresh
 * instance ids and rewires indicator-on-indicator sources to them.
 */
import { isOutputRef } from '@tickerglass/indicators';
import { useHistory } from '../commands/history';
import { newInstanceId, validateInstances, type IndicatorState } from '../indicators/model';
import { useIndicatorStore } from '../indicators/store';
import { parseIndicatorList } from './layoutState';

export const INDICATOR_TEMPLATE_SCHEMA_VERSION = 1;

/** Copies of `list` with new ids; source references inside the set follow the new ids. */
export function instantiateTemplate(list: readonly IndicatorState[]): IndicatorState[] {
  const ids = new Map(list.map((i) => [i.id, newInstanceId(i.type)]));
  return list.map((inst) => {
    const copy = structuredClone(inst);
    copy.id = ids.get(inst.id)!;
    for (const [k, v] of Object.entries(copy.inputs))
      if (isOutputRef(v) && ids.has(v.instanceId))
        copy.inputs[k] = { ...v, instanceId: ids.get(v.instanceId)! };
    return copy;
  });
}

/** Validate untrusted template contents (from the API or an import). */
export function parseTemplateInstances(raw: unknown): IndicatorState[] {
  return parseIndicatorList(raw);
}

/**
 * Put a template on the chart as one undo step: `replace` removes the
 * current indicators first, `add` appends. Returns an error message or null.
 */
export function applyIndicatorTemplate(
  instances: unknown,
  mode: 'replace' | 'add',
  name: string,
): string | null {
  const incoming = instantiateTemplate(parseTemplateInstances(instances));
  if (!incoming.length) return `Template "${name}" has no indicators`;
  const store = useIndicatorStore.getState();
  const before = store.instances;
  const after = mode === 'replace' ? incoming : [...before, ...incoming];
  const error = validateInstances(after);
  if (error) return error;
  store.replaceAll(after);
  useHistory.getState().push({
    label: `Apply template ${name}`,
    undo: () => useIndicatorStore.getState().replaceAll(before),
    redo: () => useIndicatorStore.getState().replaceAll(after),
  });
  return null;
}
