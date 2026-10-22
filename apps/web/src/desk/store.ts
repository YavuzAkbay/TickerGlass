/**
 * Desks: named workspaces, each a chart layout, a watchlist and the Navigator
 * section to show ("Morning scan", "Crypto"). Saved in this browser only.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { NavSection } from '../store/ui';
import { NAV_SECTIONS } from '../store/ui';
import type { ListRef } from '../watchlist/types';

export interface Desk {
  id: string;
  name: string;
  /** Saved layout to open (null: keep whatever layout is open). */
  layoutId: string | null;
  watchlistId: ListRef | null;
  navSection: NavSection;
}

interface DeskState {
  desks: Desk[];
  activeId: string | null;
}

export const MAX_DESKS = 20;
export const MAX_DESK_NAME = 40;

export const useDesks = create<DeskState>()(
  persist(() => ({ desks: [] as Desk[], activeId: null as string | null }), {
    name: 'tickerglass-desks',
    version: 1,
    merge: (persisted, current) => ({ ...current, ...parseDesks(persisted) }),
  }),
);

const isNav = (v: unknown): v is NavSection =>
  typeof v === 'string' && (NAV_SECTIONS as readonly string[]).includes(v);

/** Keep only well-formed desks from storage. */
export function parseDesks(v: unknown): Partial<DeskState> {
  if (typeof v !== 'object' || v === null) return {};
  const raw = (v as { desks?: unknown }).desks;
  const desks: Desk[] = [];
  if (Array.isArray(raw))
    for (const d of raw.slice(0, MAX_DESKS)) {
      if (typeof d !== 'object' || d === null) continue;
      const o = d as Record<string, unknown>;
      if (typeof o.id !== 'string' || typeof o.name !== 'string' || !o.name.trim()) continue;
      desks.push({
        id: o.id,
        name: o.name.slice(0, MAX_DESK_NAME),
        layoutId: typeof o.layoutId === 'string' ? o.layoutId : null,
        watchlistId: typeof o.watchlistId === 'string' ? (o.watchlistId as ListRef) : null,
        navSection: isNav(o.navSection) ? o.navSection : 'watchlist',
      });
    }
  const activeId = (v as { activeId?: unknown }).activeId;
  return {
    desks,
    activeId:
      typeof activeId === 'string' && desks.some((d) => d.id === activeId) ? activeId : null,
  };
}

export function addDesk(desk: Omit<Desk, 'id'>): Desk | null {
  const { desks } = useDesks.getState();
  if (desks.length >= MAX_DESKS) return null;
  const created: Desk = {
    ...desk,
    name: desk.name.slice(0, MAX_DESK_NAME),
    id: crypto.randomUUID(),
  };
  useDesks.setState({ desks: [...desks, created], activeId: created.id });
  return created;
}

export function updateDesk(id: string, patch: Partial<Omit<Desk, 'id'>>): void {
  useDesks.setState((s) => ({
    desks: s.desks.map((d) =>
      d.id === id
        ? { ...d, ...patch, ...(patch.name ? { name: patch.name.slice(0, MAX_DESK_NAME) } : {}) }
        : d,
    ),
  }));
}

export function removeDesk(id: string): void {
  useDesks.setState((s) => ({
    desks: s.desks.filter((d) => d.id !== id),
    activeId: s.activeId === id ? null : s.activeId,
  }));
}
