import {
  AlarmClock,
  ArrowUpDown,
  CalendarDays,
  ListTree,
  Newspaper,
  NotebookPen,
  Rows3,
  TableProperties,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import type { MessageKey } from '../i18n';
import { ReplayTrading } from '../replay/ReplayTrading';
import { Alerts } from '../sidebar/panels/Alerts';
import { DataWindow } from '../sidebar/panels/DataWindow';
import { News } from '../sidebar/panels/News';
import { Notes } from '../sidebar/panels/Notes';
import { ObjectTree } from '../sidebar/panels/ObjectTree';
import { Watchlist } from '../sidebar/panels/Watchlist';
import type { NavSection } from '../store/ui';
import { EventsPanel } from './EventsPanel';

export interface SectionDef {
  id: NavSection;
  title: MessageKey;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  render: () => ReactNode;
}

/** Navigator sections in rail order (matches NAV_SECTIONS). */
export const SECTIONS: SectionDef[] = [
  { id: 'watchlist', title: 'nav.watchlist', icon: Rows3, render: () => <Watchlist /> },
  { id: 'alerts', title: 'nav.alerts', icon: AlarmClock, render: () => <Alerts /> },
  { id: 'events', title: 'nav.events', icon: CalendarDays, render: () => <EventsPanel /> },
  { id: 'news', title: 'nav.news', icon: Newspaper, render: () => <News /> },
  { id: 'notes', title: 'nav.notes', icon: NotebookPen, render: () => <Notes /> },
  { id: 'objectTree', title: 'nav.objectTree', icon: ListTree, render: () => <ObjectTree /> },
  {
    id: 'dataWindow',
    title: 'nav.dataWindow',
    icon: TableProperties,
    render: () => <DataWindow />,
  },
  {
    id: 'replayTrading',
    title: 'nav.replayTrading',
    icon: ArrowUpDown,
    render: () => <ReplayTrading />,
  },
];
