import { loadLayout } from '../persist/commands';
import { useLayoutStatus } from '../persist/layouts';
import { useUiStore } from '../store/ui';
import { toast } from '../ui/Toast';
import { useWatchlistPrefs } from '../watchlist/prefs';
import { addDesk, updateDesk, useDesks, type Desk } from './store';

/** What a desk captures, read from the current workspace. */
export function currentWorkspace(): Omit<Desk, 'id' | 'name'> {
  const ui = useUiStore.getState();
  return {
    layoutId: useLayoutStatus.getState().current?.id ?? null,
    watchlistId: useWatchlistPrefs.getState().activeId,
    navSection: ui.navSection,
  };
}

export function saveDeskAs(name: string): void {
  const desk = addDesk({ name, ...currentWorkspace() });
  if (desk) toast(`Desk "${desk.name}" saved`, 'success');
  else toast('Too many desks: remove one first', 'error');
}

export function updateDeskFromCurrent(id: string): void {
  updateDesk(id, currentWorkspace());
  const name = useDesks.getState().desks.find((d) => d.id === id)?.name;
  if (name) toast(`Desk "${name}" updated`, 'success');
}

/** Switch to a desk: its layout (asking about unsaved changes), watchlist and panel. */
export async function openDesk(id: string): Promise<void> {
  const desk = useDesks.getState().desks.find((d) => d.id === id);
  if (!desk) return;
  if (desk.layoutId && desk.layoutId !== useLayoutStatus.getState().current?.id) {
    if (!(await loadLayout(desk.layoutId))) return;
  }
  if (desk.watchlistId) useWatchlistPrefs.getState().setActive(desk.watchlistId);
  useUiStore.getState().showNav(desk.navSection);
  useDesks.setState({ activeId: desk.id });
}
