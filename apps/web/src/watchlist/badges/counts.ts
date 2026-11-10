/** Per-symbol alert counts, indexed once per `alerts` object (not per row per tick). */
import type { Alert } from '@tickerglass/alerts';
import { useMemo } from 'react';
import { useAlerts } from '../../alerts/store';
import { noteKey, useNotesStore, type NoteEntry } from '../../persist/notes';

export interface AlertCounts {
  active: number;
  triggered: number;
}

const NONE: AlertCounts = { active: 0, triggered: 0 };

/** Upper-case symbol -> counts of active and triggered alerts. */
export function buildAlertIndex(alerts: Record<string, Alert>): Map<string, AlertCounts> {
  const out = new Map<string, AlertCounts>();
  for (const a of Object.values(alerts)) {
    if (a.status !== 'active' && a.status !== 'triggered') continue;
    const key = a.symbol.trim().toUpperCase();
    const cur = out.get(key) ?? { active: 0, triggered: 0 };
    if (a.status === 'active') cur.active += 1;
    else cur.triggered += 1;
    out.set(key, cur);
  }
  return out;
}

let lastAlerts: Record<string, Alert> | null = null;
let lastIndex = new Map<string, AlertCounts>();

/** `buildAlertIndex` memoized on the identity of the store's `alerts` record. */
export function alertIndex(alerts: Record<string, Alert>): Map<string, AlertCounts> {
  if (alerts !== lastAlerts) {
    lastIndex = buildAlertIndex(alerts);
    lastAlerts = alerts;
  }
  return lastIndex;
}

/** Counts for an upper-case `key` from the memoized index. */
export function selectAlertCounts(alerts: Record<string, Alert>, key: string): AlertCounts {
  return alertIndex(alerts).get(key) ?? NONE;
}

/** True when `notes` holds a non-empty note for `symbol`. */
export function selectHasNote(notes: Record<string, NoteEntry>, symbol: string): boolean {
  const key = noteKey(symbol);
  return key ? (notes[key]?.text.trim().length ?? 0) > 0 : false;
}

/** Active / triggered alert counts for `symbol`. Re-renders only when its own counts change. */
export function useSymbolAlertCount(symbol: string): AlertCounts {
  const key = symbol.trim().toUpperCase();
  // Primitive selectors: stable between unrelated store updates.
  const active = useAlerts((s) => selectAlertCounts(s.alerts, key).active);
  const triggered = useAlerts((s) => selectAlertCounts(s.alerts, key).triggered);
  return useMemo(() => (active || triggered ? { active, triggered } : NONE), [active, triggered]);
}

/** True when the symbol has a non-empty note (notes are loaded globally by the persist layer). */
export function useSymbolHasNote(symbol: string): boolean {
  return useNotesStore((s) => selectHasNote(s.notes, symbol));
}
