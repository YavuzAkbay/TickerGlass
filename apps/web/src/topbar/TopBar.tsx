import { Moon, Redo2, Rewind, SquareFunction, Sun, Undo2 } from 'lucide-react';
import { useRef, useState, type ComponentType } from 'react';
import { useHistory } from '../commands/history';
import { useT } from '../i18n';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { useChartView } from '../store/chartView';
import { useReplayStore } from '../replay/store';
import { IconButton } from '../ui/IconButton';
import { useIsMobile, useMediaQuery } from '../ui/useMediaQuery';
import { Menu, type MenuItem } from '../ui/Menu';
import { Popover } from '../ui/Popover';
import { BudgetStatus } from './BudgetStatus';
import { CHART_TYPE_MENU, chartTypeDef } from './chartTypes';
import { IndicatorTemplatesButton } from './IndicatorTemplatesButton';
import { IntervalControl } from './IntervalControl';
import { LayoutMenu } from './LayoutMenu';
import { LayoutPicker } from './LayoutPicker';
import { OverflowMenu } from './OverflowMenu';
import { PaletteButton } from './PaletteButton';
import { firstShortcut, useCommand } from './useCommand';
import { FIT_MAX, useFitLevel } from './useFitLevel';
import './topbar.css';

const run = (id: string, arg?: unknown) => commands.execute(id, arg);

/**
 * Command bar: brand and layout on the left, the command box in the middle (it runs
 * everything: "rsi 14", "4h", "compare MSFT", "alert above 200"), and view toggles on the
 * right. On desktop the chart controls (interval, type, indicators, replay) float over the
 * chart in `ChartIsland`; phones keep them in this bar.
 */
export function TopBar() {
  const t = useT();
  const bar = useRef<HTMLDivElement>(null);
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const palette = useRef<HTMLButtonElement>(null);
  // Narrow windows fold the bar step by step instead of letting groups overlap.
  const mobile = useIsMobile();
  const fit = useFitLevel({ bar, left, right, palette, enabled: !mobile });
  // Phones: search, interval, chart type and indicators stay; the rest folds into "More".
  const level = mobile ? FIT_MAX : fit.level;
  const overflow = mobile ? false : fit.overflow;
  const folded = level >= FIT_MAX;
  const cls = ['top-bar', ...Array.from({ length: level }, (_, i) => `tb-fit${i + 1}`)];
  if (mobile) cls.push('tb-mobile');
  if (overflow) cls.push('tb-overflow');
  return (
    <div ref={bar} className={cls.join(' ')} role="toolbar" aria-label={t('topbar.toolbar')}>
      <div className="tb-side tb-left">
        <div ref={left} className="tb-group">
          {mobile ? (
            <ChartControls compact />
          ) : (
            <>
              <Brand />
              <LayoutMenu />
            </>
          )}
        </div>
      </div>
      <PaletteButton ref={palette} />
      <div className="tb-side tb-right">
        <div ref={right} className="tb-group">
          <BudgetStatus />
          {mobile ? <LayoutMenu /> : <LayoutPicker />}
          {mobile ? null : <div className="tb-sep" />}
          {folded ? null : (
            <>
              <UndoRedo />
              <ThemeButton />
            </>
          )}
          <OverflowMenu folded={folded} />
        </div>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="tb-brand" aria-hidden="true">
      <span className="tb-brand-mark" />
      <span className="tb-brand-name">TickerGlass</span>
    </div>
  );
}

/** Interval, chart type, indicators, indicator sets and replay: the controls of the active chart. */
export function ChartControls({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const mobile = useIsMobile();
  const replayOn = useReplayStore((s) => s.status !== 'off');
  return (
    <>
      <IntervalControl compact={compact} />
      {mobile ? null : <div className="tb-sep" />}
      <ChartTypeButton />
      <CommandButton id="chart.indicators" icon={SquareFunction} label={t('topbar.indicators')} />
      {mobile ? null : (
        <>
          <IndicatorTemplatesButton />
          <CommandButton
            id="replay.toggle"
            icon={Rewind}
            label={t('topbar.replay')}
            active={replayOn}
          />
        </>
      )}
    </>
  );
}

/** Desktop: the chart controls as a glass island floating over the top-right of the chart. */
export function ChartIsland() {
  const t = useT();
  const compact = useMediaQuery('(max-width: 1180px)');
  return (
    <div className="chart-island glass" role="toolbar" aria-label={t('topbar.toolbar')}>
      <ChartControls compact={compact} />
    </div>
  );
}

interface CommandButtonProps {
  id: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  /** Show `label` next to the icon. */
  showLabel?: boolean;
  /** Short text next to the icon (hidden on narrow screens). */
  text?: string;
  /** Pressed look (a mode that is on). */
  active?: boolean;
}

/** Icon button bound to a command; tooltip shows its shortcut. */
function CommandButton({ id, icon, label, showLabel, text, active }: CommandButtonProps) {
  const cmd = useCommand(id);
  const shortcut = firstShortcut(cmd);
  const visible = showLabel ? label : text;
  return (
    <IconButton
      icon={icon}
      label={label}
      {...(shortcut ? { shortcut } : {})}
      className={visible ? 'tb-labeled' : ''}
      {...(active === undefined ? {} : { active })}
      onClick={() => run(id)}
    >
      {visible ? (
        <span className={`tb-label${showLabel ? '' : ' tb-collapsible'}`}>{visible}</span>
      ) : null}
    </IconButton>
  );
}

function UndoRedo() {
  const t = useT();
  const canUndo = useHistory((s) => s.past.length > 0);
  const canRedo = useHistory((s) => s.future.length > 0);
  const undoLabel = useHistory((s) => s.past.at(-1)?.label);
  const redoLabel = useHistory((s) => s.future[0]?.label);
  const undo = firstShortcut(useCommand('edit.undo'));
  const redo = firstShortcut(useCommand('edit.redo'));
  return (
    <>
      <IconButton
        icon={Undo2}
        label={undoLabel ? t('topbar.undoItem', { label: undoLabel }) : t('topbar.undo')}
        {...(undo ? { shortcut: undo } : {})}
        disabled={!canUndo}
        onClick={() => run('edit.undo')}
      />
      <IconButton
        icon={Redo2}
        label={redoLabel ? t('topbar.redoItem', { label: redoLabel }) : t('topbar.redo')}
        {...(redo ? { shortcut: redo } : {})}
        disabled={!canRedo}
        onClick={() => run('edit.redo')}
      />
    </>
  );
}

function ChartTypeButton() {
  const t = useT();
  const chartType = useChartView((s) => s.chartType);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const current = chartTypeDef(chartType);
  const Icon = current?.icon;

  const items: MenuItem[] = CHART_TYPE_MENU.map((t): MenuItem =>
    t
      ? {
          label: t.label,
          icon: t.icon,
          checked: t.id === chartType,
          onSelect: () => useChartView.getState().set({ chartType: t.id }),
        }
      : { type: 'separator' },
  );

  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`tb-btn tb-charttype${open ? ' open' : ''}`}
        aria-label={t('topbar.chartType', { type: current?.label ?? chartType })}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : current?.label}
        data-tip-side="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        {Icon ? <Icon size={18} /> : null}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} ignore={[anchor]}>
        <Menu items={items} onClose={() => setOpen(false)} />
      </Popover>
    </>
  );
}

function ThemeButton() {
  const t = useT();
  const theme = useAppStore((s) => s.theme);
  return (
    <IconButton
      icon={theme === 'dark' ? Sun : Moon}
      label={theme === 'dark' ? t('topbar.themeLight') : t('topbar.themeDark')}
      onClick={() => run('view.toggleTheme')}
    />
  );
}
