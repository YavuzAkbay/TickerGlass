import {
  AlarmClock,
  ArrowUpDown,
  FileText,
  Keyboard,
  ListTree,
  Newspaper,
  NotebookPen,
  Plus,
  Rows3,
  TableProperties,
  X,
} from 'lucide-react';
import { useRef, type ComponentType, type ReactNode } from 'react';
import { useAlerts } from '../alerts/store';
import { commands } from '../commands/registry';
import { ReplayTrading } from '../replay/ReplayTrading';
import { useReplayStore } from '../replay/store';
import { useUiStore, type RightPanel } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { Alerts } from './panels/Alerts';
import { DataWindow } from './panels/DataWindow';
import { Details } from './panels/Details';
import { News } from './panels/News';
import { Notes } from './panels/Notes';
import { ObjectTree } from './panels/ObjectTree';
import { Watchlist } from './panels/Watchlist';
import './sidebar.css';

interface PanelDef {
  id: RightPanel;
  title: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  render: () => ReactNode;
}

const PANELS: PanelDef[] = [
  { id: 'watchlist', title: 'Watchlist', icon: Rows3, render: () => <Watchlist /> },
  { id: 'alerts', title: 'Alerts', icon: AlarmClock, render: () => <Alerts /> },
  { id: 'objectTree', title: 'Object tree', icon: ListTree, render: () => <ObjectTree /> },
  { id: 'dataWindow', title: 'Data window', icon: TableProperties, render: () => <DataWindow /> },
  { id: 'details', title: 'Details', icon: FileText, render: () => <Details /> },
  { id: 'news', title: 'News', icon: Newspaper, render: () => <News /> },
  { id: 'notes', title: 'Notes', icon: NotebookPen, render: () => <Notes /> },
  {
    id: 'replayTrading',
    title: 'Replay trading',
    icon: ArrowUpDown,
    render: () => <ReplayTrading />,
  },
];

const DEFAULT_WIDTH = 300;

function ResizeHandle() {
  const start = useRef<{ x: number; w: number } | null>(null);
  return (
    <div
      className="rs-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel (double-click to reset)"
      onPointerDown={(e) => {
        start.current = { x: e.clientX, w: useUiStore.getState().rightWidth };
        e.currentTarget.setPointerCapture(e.pointerId);
        e.currentTarget.classList.add('dragging');
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s) useUiStore.getState().setRightWidth(s.w + (s.x - e.clientX));
      }}
      onPointerUp={(e) => {
        start.current = null;
        e.currentTarget.classList.remove('dragging');
      }}
      onDoubleClick={() => useUiStore.getState().setRightWidth(DEFAULT_WIDTH)}
    />
  );
}

/** Right side: resizable panel (when open) plus the far-right icon bar. */
export function RightSidebar() {
  const panel = useUiStore((s) => s.rightPanel);
  const width = useUiStore((s) => s.rightWidth);
  const togglePanel = useUiStore((s) => s.togglePanel);
  const def = PANELS.find((p) => p.id === panel);
  const unreadAlerts = useAlerts((s) => s.unread);
  const replaying = useReplayStore((s) => s.status !== 'off');

  return (
    <div className="right-sidebar">
      {def ? (
        <section className="rs-panel" style={{ width }} aria-label={def.title}>
          <ResizeHandle />
          <header className="rs-header">
            <span className="rs-title">{def.title}</span>
            {def.id === 'watchlist' ? (
              <IconButton
                icon={Plus}
                label="Add symbol"
                tipSide="bottom"
                className="rs-head-btn"
                onClick={() => commands.execute('watchlist.searchAdd')}
              />
            ) : null}
            {def.id === 'alerts' ? (
              <IconButton
                icon={Plus}
                label="Create alert"
                tipSide="bottom"
                className="rs-head-btn"
                onClick={() => commands.execute('alert.create', {})}
              />
            ) : null}
            <IconButton
              icon={X}
              label="Close panel"
              tipSide="bottom"
              className="rs-head-btn"
              onClick={() => togglePanel(def.id)}
            />
          </header>
          <div className="rs-body" key={def.id}>
            {def.render()}
          </div>
        </section>
      ) : null}
      <nav className="rs-iconbar" aria-label="Side panels">
        {PANELS.filter((p) => p.id !== 'replayTrading' || replaying).map((p) => (
          <IconButton
            key={p.id}
            icon={p.icon}
            size={20}
            label={p.title}
            tipSide="left"
            active={panel === p.id}
            data-panel={p.id}
            className="rs-icon-btn"
            onClick={() => togglePanel(p.id)}
          >
            {p.id === 'alerts' && unreadAlerts ? (
              <span className="rs-badge rs-icon-badge" aria-label={`${unreadAlerts} unread`}>
                {unreadAlerts > 99 ? '99+' : unreadAlerts}
              </span>
            ) : null}
          </IconButton>
        ))}
        <div className="rs-iconbar-spacer" />
        <IconButton
          icon={Keyboard}
          size={20}
          label="Keyboard shortcuts"
          tipSide="left"
          className="rs-icon-btn"
          onClick={() => commands.execute('view.shortcuts')}
        />
      </nav>
    </div>
  );
}
