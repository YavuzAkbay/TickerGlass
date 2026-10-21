/** In-memory alerts by id; diffs a fresh list against memory (docs/alerts.md §3.1). */
import type { Alert } from '@tickerglass/alerts';

export interface RegistryDiff {
  added: Alert[];
  /** Same id, different revision/status/updatedAt. */
  changed: Alert[];
  removed: Alert[];
}

export class Registry {
  private readonly byId = new Map<string, Alert>();

  get(id: string): Alert | undefined {
    return this.byId.get(id);
  }
  all(): Alert[] {
    return [...this.byId.values()];
  }
  ids(): string[] {
    return [...this.byId.keys()];
  }
  get size(): number {
    return this.byId.size;
  }

  /** Replace memory with `list`. */
  apply(list: readonly Alert[]): RegistryDiff {
    const diff: RegistryDiff = { added: [], changed: [], removed: [] };
    const seen = new Set<string>();
    for (const a of list) {
      seen.add(a.id);
      const d = this.upsert(a);
      if (d === 'added') diff.added.push(a);
      else if (d === 'changed') diff.changed.push(a);
    }
    for (const [id, old] of [...this.byId]) {
      if (!seen.has(id)) {
        this.byId.delete(id);
        diff.removed.push(old);
      }
    }
    return diff;
  }

  upsert(a: Alert): 'added' | 'changed' | 'same' {
    const old = this.byId.get(a.id);
    this.byId.set(a.id, a);
    if (!old) return 'added';
    return old.revision !== a.revision || old.status !== a.status ? 'changed' : 'same';
  }

  remove(id: string): Alert | undefined {
    const old = this.byId.get(id);
    this.byId.delete(id);
    return old;
  }
}
