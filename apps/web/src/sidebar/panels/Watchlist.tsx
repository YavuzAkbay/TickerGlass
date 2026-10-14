import { Rows3 } from 'lucide-react';
import { commands } from '../../commands/registry';
import { resolveActive } from '../../watchlist/model';
import { useWatchlistPrefs } from '../../watchlist/prefs';
import { useWatchlistStore } from '../../watchlist/store';
import { Toolbar } from '../watchlist/Toolbar';
import { WatchlistTable } from '../watchlist/WatchlistTable';
import '../watchlist/watchlist.css';

/** Watchlists: list switcher, sections, flags, sortable live quote columns. */
export function Watchlist() {
  const lists = useWatchlistStore((s) => s.lists);
  const activeId = useWatchlistPrefs((s) => s.activeId);
  const active = resolveActive(activeId, lists);

  return (
    <div className="wl-panel">
      <Toolbar />
      {active ? (
        <WatchlistTable key={active} listRef={active} />
      ) : (
        <div className="rs-empty">
          <Rows3 size={36} strokeWidth={1.2} />
          <div className="rs-empty-title">No watchlists</div>
          <div className="rs-empty-text">Create a list to track symbols.</div>
          <button
            type="button"
            className="io-btn rs-empty-btn"
            onClick={() => commands.execute('watchlist.create')}
          >
            Create list
          </button>
        </div>
      )}
    </div>
  );
}
