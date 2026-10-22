import { LayoutDashboard } from 'lucide-react';
import { useState } from 'react';
import { useT } from '../i18n';
import { DropdownMenu, type MenuItem } from '../ui/Menu';
import { confirmDialog, promptName } from '../ui/Prompt';
import { openDesk, saveDeskAs, updateDeskFromCurrent } from './actions';
import { removeDesk, updateDesk, useDesks } from './store';

/** Desk switcher at the top of the Navigator rail. */
export function DeskButton() {
  const t = useT();
  const desks = useDesks((s) => s.desks);
  const activeId = useDesks((s) => s.activeId);
  const active = desks.find((d) => d.id === activeId);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  const items: MenuItem[] = [
    { type: 'header', label: t('desk.title') },
    ...desks.map((d): MenuItem => ({
      label: d.name,
      checked: d.id === activeId,
      onSelect: () => void openDesk(d.id),
    })),
    ...(desks.length ? [] : [{ type: 'header', label: t('desk.none') } as MenuItem]),
    { type: 'separator' },
    {
      label: t('desk.saveAs'),
      onSelect: async () => {
        const name = await promptName({ title: t('desk.saveAs'), okLabel: 'Save' });
        if (name) saveDeskAs(name);
      },
    },
  ];
  if (active)
    items.push(
      {
        label: t('desk.update', { name: active.name }),
        onSelect: () => updateDeskFromCurrent(active.id),
      },
      {
        label: t('desk.rename'),
        onSelect: async () => {
          const name = await promptName({
            title: t('desk.rename'),
            initial: active.name,
            okLabel: 'Rename',
          });
          if (name) updateDesk(active.id, { name });
        },
      },
      {
        label: t('desk.delete'),
        danger: true,
        onSelect: async () => {
          const yes = await confirmDialog({
            title: t('desk.delete'),
            message: `Delete the desk "${active.name}"? Its layout and watchlist stay.`,
            okLabel: 'Delete',
            danger: true,
          });
          if (yes) removeDesk(active.id);
        },
      },
    );

  const label = active ? t('desk.current', { name: active.name }) : t('desk.title');
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`nav-tab nav-desk${active ? ' set' : ''}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={label}
        data-tip-side="right"
        onClick={() => setOpen((o) => !o)}
      >
        {active ? (
          <span className="nav-desk-initial" aria-hidden="true">
            {active.name.trim().charAt(0).toUpperCase()}
          </span>
        ) : (
          <LayoutDashboard size={18} strokeWidth={1.6} />
        )}
      </button>
      <DropdownMenu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        placement="right-start"
      />
    </>
  );
}
