/**
 * Keeps stub definitions of the user scripts in the indicator registry
 * (`user:<id>`, metadata only: user code runs in the sandbox). A script with
 * no manifest, or one that fails `parseManifest`, registers nothing; see
 * `userScriptProblem` for what the UI shows for it.
 */
import {
  USER_SCRIPT_PREFIX,
  defaultRegistry,
  definitionFromManifest,
  isUserScriptType,
  parseManifest,
  scriptIdOf,
  type AnyIndicatorDefinition,
  type IndicatorRegistry,
} from '@tickerglass/indicators';
import type { UserScript } from '../api/types';
import { useScriptsStore } from './store';

interface Tracked {
  /** Source and manifest as last applied: any difference means the sandbox must reload the script. */
  sig: string;
  registered: boolean;
}

const tracked = new WeakMap<IndicatorRegistry, Map<string, Tracked>>();

function definitionOf(script: UserScript): AnyIndicatorDefinition | null {
  if (!script.manifest) return null;
  try {
    return definitionFromManifest(parseManifest(script.manifest));
  } catch {
    return null;
  }
}

/**
 * Register, replace and remove stubs so the registry matches `scripts`.
 * Returns the ids of scripts that are new, gone, or whose source or manifest
 * changed (the caller then runs `ctl.sync()` and `port.reloadScript(id)`).
 */
export function syncScriptDefinitions(
  scripts: readonly UserScript[],
  registry: IndicatorRegistry = defaultRegistry,
): string[] {
  let prev = tracked.get(registry);
  if (!prev) tracked.set(registry, (prev = new Map()));
  const next = new Map<string, Tracked>();
  const changed: string[] = [];
  for (const script of scripts) {
    const type = USER_SCRIPT_PREFIX + script.id;
    const sig = JSON.stringify([script.source, script.manifest]);
    const before = prev.get(script.id);
    if (before?.sig === sig) {
      next.set(script.id, before);
      continue;
    }
    registry.unregister(type);
    const def = definitionOf(script);
    if (def) registry.register({ ...def, id: type });
    next.set(script.id, { sig, registered: def !== null });
    changed.push(script.id);
  }
  for (const id of prev.keys()) {
    if (next.has(id)) continue;
    registry.unregister(USER_SCRIPT_PREFIX + id);
    changed.push(id);
  }
  tracked.set(registry, next);
  return changed;
}

/** Why an instance of `type` cannot run, for the legend; undefined if fine (or not a user script, or scripts not loaded yet). */
export function userScriptProblem(type: string): string | undefined {
  if (!isUserScriptType(type)) return undefined;
  const { scripts, loaded } = useScriptsStore.getState();
  if (!loaded) return undefined;
  const script = scripts.find((s) => s.id === scriptIdOf(type));
  if (!script) return 'Script deleted';
  if (!defaultRegistry.get(type)) return 'Script has errors – open it in the editor';
  return undefined;
}
