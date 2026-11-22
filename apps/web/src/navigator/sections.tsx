import {
  AlarmClock,
  ArrowUpDown,
  Briefcase,
  FlaskConical,
  Flame,
  History,
  ListTree,
  NotebookPen,
  Rows3,
  TableProperties,
} from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { StrategyPanel } from '../backtest/StrategyPanel';
import type { MessageKey } from '../i18n';
import { PortfolioPanel } from '../portfolio/PortfolioPanel';
import { ReplayTrading } from '../replay/ReplayTrading';
import { Alerts } from '../sidebar/panels/Alerts';
import { DataWindow } from '../sidebar/panels/DataWindow';
import { Hotlists } from '../sidebar/panels/Hotlists';
import { Notes } from '../sidebar/panels/Notes';
import { ObjectTree } from '../sidebar/panels/ObjectTree';
import { Watchlist } from '../sidebar/panels/Watchlist';
import type { NavSection } from '../store/ui';
import { Timeline } from './Timeline';

export interface SectionDef {
  id: NavSection;
  title: MessageKey;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  render: () => ReactNode;
}

/** Navigator sections in rail order (matches NAV_SECTIONS). */
export const SECTIONS: SectionDef[] = [
  { id: 'watchlist', title: 'nav.watchlist', icon: Rows3, render: () => <Watchlist /> },
  { id: 'hotlists', title: 'nav.hotlists', icon: Flame, render: () => <Hotlists /> },
  { id: 'alerts', title: 'nav.alerts', icon: AlarmClock, render: () => <Alerts /> },
  { id: 'timeline', title: 'nav.timeline', icon: History, render: () => <Timeline /> },
  { id: 'notes', title: 'nav.notes', icon: NotebookPen, render: () => <Notes /> },
  { id: 'objectTree', title: 'nav.objectTree', icon: ListTree, render: () => <ObjectTree /> },
  {
    id: 'dataWindow',
    title: 'nav.dataWindow',
    icon: TableProperties,
    render: () => <DataWindow />,
  },
  {
    id: 'strategy',
    title: 'nav.strategy',
    icon: FlaskConical,
    render: () => <StrategyPanel />,
  },
  {
    id: 'portfolio',
    title: 'nav.portfolio',
    icon: Briefcase,
    render: () => <PortfolioPanel />,
  },
  {
    id: 'replayTrading',
    title: 'nav.replayTrading',
    icon: ArrowUpDown,
    render: () => <ReplayTrading />,
  },
];
