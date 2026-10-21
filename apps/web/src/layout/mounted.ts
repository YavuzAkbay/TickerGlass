/**
 * Coordination between layout state and the grid UI: which charts have a
 * mounted session yet, and keeping the layout's active chart in step with
 * the focused one.
 */
import { useChartStore } from '../store/chart';
import { useLayoutGrid } from './store';

let mounts = 0;

/** The grid UI is on screen (until the returned function runs): layout applies wait for its cells. */
export function markGridMounted(): () => void {
  mounts++;
  const sync = () => {
    const { activeId, sessions } = useChartStore.getState();
    // Moving focus to another chart (or losing the maximized one) restores the grid.
    const { maximizedId } = useLayoutGrid.getState();
    if (maximizedId !== null && maximizedId !== activeId)
      useLayoutGrid.setState({ maximizedId: null });
    if (
      activeId !== null &&
      sessions.has(activeId) &&
      useLayoutGrid.getState().activeId !== activeId
    )
      useLayoutGrid.setState({ activeId });
  };
  sync();
  const off = useChartStore.subscribe(sync);
  return () => {
    off();
    mounts--;
  };
}

/**
 * Resolves once every chart in `ids` has a session. Resolves at once without a
 * mounted grid (unit tests, before the first render) and after `timeoutMs`, so
 * a cell that fails to mount cannot block applying the rest of a layout.
 */
export function whenMounted(ids: readonly string[], timeoutMs = 5000): Promise<void> {
  const ready = () => ids.every((id) => useChartStore.getState().sessions.has(id));
  if (mounts === 0 || ready()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const off = useChartStore.subscribe(() => {
      if (ready()) done();
    });
    const timer = setTimeout(done, timeoutMs);
  });
}
