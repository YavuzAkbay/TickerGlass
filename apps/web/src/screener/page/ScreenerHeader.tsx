import { ArrowLeft, Download, MoreHorizontal, PanelRight } from 'lucide-react';
import { useState } from 'react';
import { ViewToggle } from '../../heatmap/ViewToggle';
import type { ViewMode } from '../../heatmap/viewMode';
import { useT } from '../../i18n';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { IconButton } from '../../ui/IconButton';
import { UNIVERSE_AS_OF } from '../universe/types';

interface Props {
  onBack: () => void;
  onExportCsv: () => void;
  /** Extra page actions (the bulk "add results to watchlist" submenu). */
  extraItems?: MenuItem[];
  detailOpen: boolean;
  onToggleDetail: () => void;
  /** Table | Heatmap switch (hidden when omitted). */
  view?: ViewMode;
  onViewChange?: (view: ViewMode) => void;
  /** Replaces the bundled-universe date chip (server mode shows the snapshot date). */
  stamp?: { text: string; title: string };
}

/** Top bar of the screener screen: back, title, universe stamp, page actions. */
export function ScreenerHeader({
  onBack,
  onExportCsv,
  extraItems = [],
  detailOpen,
  onToggleDetail,
  view,
  onViewChange,
  stamp,
}: Props) {
  const t = useT();
  const [menuBtn, setMenuBtn] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const items: MenuItem[] = [
    { label: t('scr.exportCsv'), icon: Download, onSelect: onExportCsv },
    ...extraItems,
  ];

  return (
    <header className="scr-header">
      <IconButton
        icon={ArrowLeft}
        label={t('scr.back')}
        tipSide="bottom"
        className="scr-back"
        data-testid="scr-back"
        onClick={onBack}
      />
      <h1 className="scr-title">{t('scr.title')}</h1>
      <span
        className="scr-asof"
        data-testid="scr-asof"
        title={stamp?.title ?? t('scr.asOf').replace('{date}', UNIVERSE_AS_OF)}
      >
        {stamp?.text ?? UNIVERSE_AS_OF}
      </span>
      <span className="scr-header-spacer" />
      {view && onViewChange ? (
        <ViewToggle value={view} onChange={onViewChange} testId="scr-view" />
      ) : null}
      <IconButton
        icon={PanelRight}
        label={t('scr.detailPane')}
        tipSide="bottom"
        active={detailOpen}
        className="scr-head-btn"
        onClick={onToggleDetail}
      />
      <IconButton
        ref={setMenuBtn}
        icon={MoreHorizontal}
        label={t('scr.more')}
        tipSide="bottom"
        className="scr-head-btn"
        data-testid="scr-more"
        aria-haspopup="menu"
        onClick={() => setMenuOpen((o) => !o)}
      />
      <DropdownMenu
        anchor={menuBtn}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={items}
        placement="bottom-end"
      />
    </header>
  );
}
