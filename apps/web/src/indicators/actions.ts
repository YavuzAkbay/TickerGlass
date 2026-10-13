// Validated, undoable mutations of the indicator store. Commands, dialogs,
// legend rows and context menus all go through these.
import {
  getIndicator,
  resolveInputs,
  type InputValueMap,
  type OutputSourceRef,
} from '@investopen/indicators';
import { useHistory } from '../commands/history';
import { toast } from '../ui/Toast';
import {
  createInstance,
  dependentsOf,
  sourceInputKey,
  validateInstances,
  type IndicatorState,
} from './model';
import {
  effectiveInstances,
  useIndicatorPrefs,
  useIndicatorPreview,
  useIndicatorStore,
  type IndicatorPatch,
} from './store';

const store = () => useIndicatorStore.getState();
const nameOf = (inst: IndicatorState) => getIndicator(inst.type)?.shortName ?? inst.type;

export function findIndicator(id: string): IndicatorState | undefined {
  return store().instances.find((i) => i.id === id);
}

export interface AddOptions {
  /** Indicator-on-indicator: feed the new instance's first source input from this output. */
  sourceOf?: OutputSourceRef;
  inputs?: InputValueMap;
  /** Copy style/visibility settings (Duplicate). */
  from?: Pick<IndicatorState, 'styles' | 'visibility' | 'visible' | 'placement'>;
}

/** Adds an instance (with the user's saved defaults). Returns its id, or null with a toast. */
export function addIndicator(type: string, opts: AddOptions = {}): string | null {
  const def = getIndicator(type);
  if (!def) {
    toast(`Unknown indicator "${type}"`, 'error');
    return null;
  }
  const inputs: InputValueMap = { ...(opts.inputs ?? {}) };
  if (opts.sourceOf) {
    const key = sourceInputKey(def);
    if (!key) {
      toast(`${def.name} has no source input`, 'error');
      return null;
    }
    inputs[key] = { ...opts.sourceOf };
  }
  let inst: IndicatorState;
  try {
    inst = createInstance(def, useIndicatorPrefs.getState().defaults[type], inputs);
    if (opts.from) inst = { ...inst, ...structuredClone(opts.from) };
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
  const error = validateInstances([...store().instances, inst]);
  if (error) {
    toast(error, 'error');
    return null;
  }
  const index = store().instances.length;
  store().add(inst, index);
  useHistory.getState().push({
    label: `Add ${def.shortName}`,
    undo: () => store().remove(inst.id),
    redo: () => store().add(inst, index),
  });
  return inst.id;
}

export function removeIndicator(id: string): void {
  const list = store().instances;
  const index = list.findIndex((i) => i.id === id);
  const inst = list[index];
  if (!inst) return;
  const dependents = dependentsOf(list, id);
  store().remove(id);
  useHistory.getState().push({
    label: `Remove ${nameOf(inst)}`,
    undo: () => store().add(inst, index),
    redo: () => store().remove(id),
  });
  if (dependents.size)
    toast(
      `${dependents.size} indicator${dependents.size > 1 ? 's' : ''} used ${nameOf(inst)} as a source and now show an error`,
      'error',
    );
}

/**
 * Removes several indicators in one store update and one undo step (e.g. the
 * studies of a pane the user removed). Removing them one by one would let the
 * chart briefly re-add a dependent whose source pane just went away.
 */
export function removeIndicators(ids: readonly string[]): void {
  const before = store().instances;
  const drop = new Set(ids);
  const removed = before.filter((i) => drop.has(i.id));
  if (!removed.length) return;
  const after = before.filter((i) => !drop.has(i.id));
  store().replaceAll(after);
  useHistory.getState().push({
    label: removed.length === 1 ? `Remove ${nameOf(removed[0]!)}` : 'Remove indicators',
    undo: () => store().replaceAll(before),
    redo: () => store().replaceAll(after),
  });
  const orphans = new Set(
    removed.flatMap((r) => [...dependentsOf(before, r.id)]).filter((id) => !drop.has(id)),
  );
  if (orphans.size)
    toast(
      `${orphans.size} indicator${orphans.size > 1 ? 's' : ''} used a removed indicator as a source and now show an error`,
      'error',
    );
}

/** Removes every indicator as one undo step. */
export function removeAllIndicators(): void {
  const before = store().instances;
  if (!before.length) return;
  store().replaceAll([]);
  useHistory.getState().push({
    label: 'Remove indicators',
    undo: () => store().replaceAll(before),
    redo: () => store().replaceAll([]),
  });
}

type Patch = IndicatorPatch;
const preview = () => useIndicatorPreview.getState();

/**
 * Normalise `patch` for instance `id` of `list` (clamped inputs, as the worker
 * computes them) and validate the result. Null (with a toast) when invalid.
 */
function validatePatch(id: string, patch: Patch, list: readonly IndicatorState[]): Patch | null {
  const inst = list.find((i) => i.id === id);
  if (!inst) return null;
  if (!patch.inputs) return patch;
  const def = getIndicator(inst.type);
  let inputs: InputValueMap;
  try {
    if (!def) throw new Error(`Unknown indicator "${inst.type}"`);
    inputs = resolveInputs(def, patch.inputs);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
  const next = { ...patch, inputs };
  const error = validateInstances(list.map((i) => (i.id === id ? { ...i, ...next } : i)));
  if (error) {
    toast(error, 'error');
    return null;
  }
  return next;
}

/**
 * Settings dialog live preview: a transient patch over the persisted instance
 * (not persisted, no undo entry). Invalid input changes are rejected with a
 * toast; returns whether it applied.
 */
export function previewIndicator(id: string, patch: Patch): boolean {
  const next = validatePatch(id, patch, effectiveInstances());
  if (!next) return false;
  useIndicatorPreview.setState((s) => ({
    overrides: { ...s.overrides, [id]: { ...s.overrides[id], ...next } },
  }));
  return true;
}

/** Drop the preview of `id` (dialog Cancel / closed without Ok). */
export function discardPreview(id: string): void {
  if (!(id in preview().overrides)) return;
  useIndicatorPreview.setState((s) => {
    const { [id]: _dropped, ...overrides } = s.overrides;
    return { overrides };
  });
}

/** Apply the preview of `id` to the store as one undo step (dialog Ok). */
export function commitPreview(id: string, label: string): boolean {
  const patch = preview().overrides[id];
  discardPreview(id);
  return patch ? updateIndicator(id, patch, label) : false;
}

/** Record the change from `before` to the current state of the instance as one undo step. */
export function commitIndicator(before: IndicatorState, label: string): void {
  const after = findIndicator(before.id);
  if (!after || JSON.stringify(after) === JSON.stringify(before)) return;
  const { id: _i, type: _t, ...prev } = before;
  const { id: _i2, type: _t2, ...next } = after;
  useHistory.getState().push({
    label,
    undo: () => store().update(before.id, prev),
    redo: () => store().update(before.id, next),
  });
}

/** Validated, undoable patch. */
export function updateIndicator(id: string, patch: Patch, label: string): boolean {
  const before = findIndicator(id);
  const next = before && validatePatch(id, patch, store().instances);
  if (!before || !next) return false;
  store().update(id, next);
  commitIndicator(before, label);
  return true;
}

export function toggleIndicatorVisible(id: string): void {
  const inst = findIndicator(id);
  if (!inst) return;
  updateIndicator(
    id,
    { visible: !inst.visible },
    inst.visible ? 'Hide indicator' : 'Show indicator',
  );
}
