import { ArrowLeft, MoreHorizontal, PanelRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { ViewToggle } from '../../heatmap/ViewToggle';
import type { ViewMode } from '../../heatmap/viewMode';
import { commands } from '../../commands/registry';
import { useT } from '../../i18n';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { IconButton } from '../../ui/IconButton';
import { isFlagRef } from '../model';
import type { ListRef } from '../types';
import { listActionItems } from '../../sidebar/watchlist/ListSwitcher';

interface Props {
  onBack: () => void;
  active: ListRef | null;
  onExportCsv: () => void;
  detailOpen: boolean;
  onToggleDetail: () => void;
  /** Table | Heatmap switch (hidden when omitted). */
  view?: ViewMode;
  onViewChange?: (view: ViewMode) => void;
  /** First-run state: no lists yet — only back and title. */
  minimal?: boolean;
}

/** Top bar of the screen: back, title, and the page-level actions. */
export function PageHeader({
  onBack,
  active,
  onExportCsv,
  detailOpen,
  onToggleDetail,
  view,
  onViewChange,
  minimal,
}: Props) {
  const t = useT();
  const [menuBtn, setMenuBtn] = useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  const real = !!active && !isFlagRef(active);
  const items: MenuItem[] = minimal
    ? []
    : [
        {
          label: t('wlp.addSymbol'),
          icon: Plus,
          onSelect: () => commands.execute('watchlist.searchAdd'),
        },
        ...(real
          ? ([
              {
                label: t('wlp.addSection'),
                onSelect: () => commands.execute('watchlist.addSection'),
              },
            ] as MenuItem[])
          : []),
        { label: t('wlp.importList'), onSelect: () => commands.execute('watchlist.import') },
        { label: t('wlp.exportCsv'), onSelect: onExportCsv },
        ...(active
          ? ([
              { type: 'separator' as const },
              ...listActionItems(active).filter(
                (i) => 'label' in i && i.label !== 'Export list (.txt)',
              ),
            ] as MenuItem[])
          : []),
      ];

  return (
    <header className="wlp-header">
      <IconButton
        icon={ArrowLeft}
        label={t('wlp.back')}
        tipSide="bottom"
        className="wlp-back"
        data-testid="wlp-back"
        onClick={onBack}
      />
      <h1 className="wlp-title">{t('wlp.title')}</h1>
      <span className="wlp-header-spacer" />
      {minimal ? null : (
        <>
          {view && onViewChange ? (
            <ViewToggle value={view} onChange={onViewChange} testId="wlp-view" />
          ) : null}
          <button
            type="button"
            className="io-btn io-btn-primary wlp-add"
            onClick={() => commands.execute('watchlist.searchAdd')}
          >
            <Plus size={14} />
            {t('wlp.addSymbol')}
          </button>
          <IconButton
            icon={PanelRight}
            label={t('wlp.detailPane')}
            tipSide="bottom"
            active={detailOpen}
            className="wlp-head-btn"
            onClick={onToggleDetail}
          />
          <IconButton
            ref={setMenuBtn}
            icon={MoreHorizontal}
            label={t('wlp.more')}
            tipSide="bottom"
            className="wlp-head-btn"
            data-testid="wlp-more"
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
        </>
      )}
    </header>
  );
}
