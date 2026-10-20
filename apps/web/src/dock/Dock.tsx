import {
  AlarmClock,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  FileText,
  ListTree,
  Newspaper,
  NotebookPen,
  Plus,
  Rows3,
  TableProperties,
} from 'lucide-react';
import { useEffect, useRef, type ComponentType, type ReactNode } from 'react';
import { useAlerts } from '../alerts/store';
import { commands } from '../commands/registry';
import { ReplayTrading } from '../replay/ReplayTrading';
import { useReplayStore } from '../replay/store';
import { Alerts } from '../sidebar/panels/Alerts';
import { DataWindow } from '../sidebar/panels/DataWindow';
import { Details } from '../sidebar/panels/Details';
import { News } from '../sidebar/panels/News';
import { Notes } from '../sidebar/panels/Notes';
import { ObjectTree } from '../sidebar/panels/ObjectTree';
import { Watchlist } from '../sidebar/panels/Watchlist';
import { DEFAULT_DOCK_HEIGHT, useUiStore, type RightPanel } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import '../sidebar/sidebar.css';
import './dock.css';

interface PanelDef {
  id: RightPanel;
  title: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  render: () => ReactNode;
}

const PANELS: PanelDef[] = [
  { id: 'watchlist', title: 'Watchlist', icon: Rows3, render: () => <Watchlist /> },
  { id: 'details', title: 'Details', icon: FileText, render: () => <Details /> },
  { id: 'news', title: 'News', icon: Newspaper, render: () => <News /> },
  { id: 'alerts', title: 'Alerts', icon: AlarmClock, render: () => <Alerts /> },
  {
    id: 'replayTrading',
    title: 'Replay trading',
    icon: ArrowUpDown,
    render: () => <ReplayTrading />,
  },
  { id: 'objectTree', title: 'Object tree', icon: ListTree, render: () => <ObjectTree /> },
  { id: 'dataWindow', title: 'Data window', icon: TableProperties, render: () => <DataWindow /> },
  { id: 'notes', title: 'Notes', icon: NotebookPen, render: () => <Notes /> },
];

/** Drag handle on the top edge of the dock; double-click restores the default height. */
function ResizeHandle() {
  const start = useRef<{ y: number; h: number } | null>(null);
  return (
    <div
      className="dock-resize"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize dock (double-click to reset)"
      onPointerDown={(e) => {
        start.current = { y: e.clientY, h: useUiStore.getState().dockHeight };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) useUiStore.getState().setDockHeight(s.h + (s.y - e.clientY));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.classList.remove('dragging');
      }}
      onDoubleClick={() => useUiStore.getState().setDockHeight(DEFAULT_DOCK_HEIGHT)}
    />
  );
}

/** Bottom dock under the chart: a tab per panel, collapsible, resizable by its top edge. */
export function Dock() {
  const panel = useUiStore((s) => s.rightPanel);
  const dockTab = useUiStore((s) => s.dockTab);
  const height = useUiStore((s) => s.dockHeight);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const unreadAlerts = useAlerts((s) => s.unread);
  const replaying = useReplayStore((s) => s.status !== 'off');

  // Remember the last open tab, however it was opened (e.g. the alerts toast).
  useEffect(() => {
    if (panel && panel !== dockTab) useUiStore.setState({ dockTab: panel });
  }, [panel, dockTab]);

  const open = panel !== null;
  const def = PANELS.find((p) => p.id === panel);
  const expand = () => {
    const tab = PANELS.some((p) => p.id === dockTab) ? dockTab : 'watchlist';
    useUiStore.setState({ rightPanel: tab === 'replayTrading' && !replaying ? 'watchlist' : tab });
  };

  return (
    <div className={`dock${open ? ' open' : ''}`} style={open ? { height } : undefined}>
      {open ? <ResizeHandle /> : null}
      <div className="dock-tabs" role="toolbar" aria-label="Panels">
        {PANELS.filter((p) => p.id !== 'replayTrading' || replaying).map((p) => {
          const Icon = p.icon;
          return (
            <button
              key={p.id}
              type="button"
              className={`dock-tab${panel === p.id ? ' active' : ''}`}
              aria-label={p.title}
              aria-pressed={panel === p.id}
              data-panel={p.id}
              onClick={() => togglePanel(p.id)}
            >
              <Icon size={15} strokeWidth={1.8} />
              <span className="dock-tab-text">{p.title}</span>
              {p.id === 'alerts' && unreadAlerts ? (
                <span className="rs-badge rs-icon-badge" aria-label={`${unreadAlerts} unread`}>
                  {unreadAlerts > 99 ? '99+' : unreadAlerts}
                </span>
              ) : null}
            </button>
          );
        })}
        <div className="dock-spacer" />
        {def?.id === 'watchlist' ? (
          <IconButton
            icon={Plus}
            label="Add symbol"
            tipSide="top"
            className="rs-head-btn"
            onClick={() => commands.execute('watchlist.searchAdd')}
          />
        ) : null}
        {def?.id === 'alerts' ? (
          <IconButton
            icon={Plus}
            label="Create alert"
            tipSide="top"
            className="rs-head-btn"
            onClick={() => commands.execute('alert.create', {})}
          />
        ) : null}
        <IconButton
          icon={open ? ChevronDown : ChevronUp}
          label={open ? 'Collapse dock' : 'Expand dock'}
          tipSide="top"
          className="rs-head-btn"
          onClick={() => (open ? useUiStore.setState({ rightPanel: null }) : expand())}
        />
      </div>
      {def ? (
        <section className="dock-body" aria-label={def.title} key={def.id}>
          {def.render()}
        </section>
      ) : null}
    </div>
  );
}
