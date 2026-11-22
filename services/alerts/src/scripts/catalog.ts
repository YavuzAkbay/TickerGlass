/**
 * The user scripts as the alerts service knows them: `GET /api/user-scripts`
 * on every sync. Gives `validateAlert` a registry (built-ins + a stub per
 * script from its stored manifest, like the web's `syncScriptDefinitions`) and
 * tells which scripts were edited or deleted since the last sync.
 */
import {
  IndicatorRegistry,
  USER_SCRIPT_API_VERSION,
  USER_SCRIPT_PREFIX,
  defaultRegistry,
  definitionFromManifest,
  parseManifest,
  type UserScriptManifest,
} from '@tickerglass/indicators';
import type { ScriptSource } from './host';
import { ownerKey, sameOwner } from '../owner';

/** A script as `GET /api/user-scripts` returns it. */
export interface StoredScript {
  id: string;
  /** The user the script belongs to (absent on servers without multi-user). */
  ownerId?: string;
  name: string;
  source: string;
  manifest: unknown;
  apiVersion: number;
  revision: number;
}

export interface CatalogScript extends ScriptSource {
  ownerId?: string;
  name: string;
  apiVersion: number;
  /** The manifest of the last save that compiled; null when it did not (or is unusable). */
  manifest: UserScriptManifest | null;
}

export class ScriptCatalog {
  /** Keyed by (ownerId, id): a script is only found by an alert of its own owner. */
  private scripts = new Map<string, CatalogScript>();
  private reg: IndicatorRegistry | null = null;
  /** A refresh succeeded at least once. */
  loaded = false;

  /** The script `id` as seen by an alert of `ownerId`: undefined for another owner's script. */
  get(id: string, ownerId: string | undefined): CatalogScript | undefined {
    const s = this.scripts.get(ownerKey(ownerId, id));
    return s && sameOwner(s.ownerId, ownerId) ? s : undefined;
  }

  list(): CatalogScript[] {
    return [...this.scripts.values()];
  }

  /**
   * Built-ins plus a stub per script with a usable manifest. Rebuilt after
   * every change; callers keep no copy.
   */
  registry(): IndicatorRegistry {
    if (this.reg) return this.reg;
    const reg = new IndicatorRegistry();
    for (const def of defaultRegistry.list()) reg.register(def);
    for (const s of this.scripts.values()) {
      if (!s.manifest || s.apiVersion !== USER_SCRIPT_API_VERSION) continue;
      try {
        reg.register(definitionFromManifest(s.manifest));
      } catch {
        // an unusable manifest: the script counts as having none
      }
    }
    this.reg = reg;
    return reg;
  }

  /**
   * Replace the catalog with `list` (the API's scripts). Returns the ids
   * whose script changed (new revision, deleted, or newly appeared).
   */
  apply(list: readonly StoredScript[]): string[] {
    const next = new Map<string, CatalogScript>();
    // The isolates know scripts by id alone. Ids are unique on the server; one that two owners
    // claim cannot be told apart there, so neither is served (fail closed).
    const owners = new Map<string, Set<string>>();
    for (const s of list) {
      const set = owners.get(s.id) ?? new Set<string>();
      set.add(s.ownerId ?? '');
      owners.set(s.id, set);
    }
    for (const s of list) {
      if ((owners.get(s.id)?.size ?? 0) > 1) continue;
      let manifest: UserScriptManifest | null = null;
      if (s.manifest !== null && s.manifest !== undefined) {
        try {
          manifest = readManifest(s);
        } catch {
          manifest = null;
        }
      }
      next.set(ownerKey(s.ownerId, s.id), {
        id: s.id,
        ...(s.ownerId !== undefined ? { ownerId: s.ownerId } : {}),
        name: s.name,
        source: s.source,
        revision: s.revision,
        apiVersion: s.apiVersion,
        manifest,
      });
    }
    const changed: string[] = [];
    for (const [key, s] of next) {
      const old = this.scripts.get(key);
      if (!old || old.revision !== s.revision) changed.push(s.id);
    }
    for (const [key, old] of this.scripts) if (!next.has(key)) changed.push(old.id);
    this.scripts = next;
    if (changed.length > 0 || !this.loaded) this.reg = null;
    this.loaded = true;
    return changed;
  }
}

/** Validated copy of the stored manifest; throws when unusable. */
function readManifest(s: StoredScript): UserScriptManifest {
  const manifest = parseManifest(s.manifest);
  if (manifest.id !== USER_SCRIPT_PREFIX + s.id)
    throw new Error('manifest id does not match the script');
  return manifest;
}
