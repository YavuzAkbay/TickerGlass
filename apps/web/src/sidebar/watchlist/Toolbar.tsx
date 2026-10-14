import { MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
import { commands } from '../../commands/registry';
import { importFile } from '../../watchlist/commands';
import { IconButton } from '../../ui/IconButton';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { isFlagRef } from '../../watchlist/model';
import { ListSwitcher, listActionItems, useActiveName } from './ListSwitcher';

/** `[list name ▾] [+ add symbol] [⋯ list menu]` plus the hidden `.txt` import input. */
export function Toolbar() {
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const { ref } = useActiveName();

  const items: MenuItem[] = [
    {
      label: 'Add section…',
      disabled: !ref || isFlagRef(ref),
      onSelect: () => commands.execute('watchlist.addSection'),
    },
    { type: 'separator' },
    { label: 'Create new list…', onSelect: () => commands.execute('watchlist.create') },
    { label: 'Import list…', onSelect: () => commands.execute('watchlist.import') },
    ...(ref ? [{ type: 'separator' } as MenuItem, ...listActionItems(ref)] : []),
  ];

  return (
    <div className="wl-toolbar">
      <ListSwitcher />
      <span className="wl-toolbar-spacer" />
      <IconButton
        ref={setBtn}
        icon={MoreHorizontal}
        label="List menu"
        tipSide="bottom"
        className="rs-head-btn"
        data-testid="wl-list-menu"
        aria-haspopup="menu"
        onClick={() => setOpen((o) => !o)}
      />
      <DropdownMenu
        anchor={btn}
        open={open}
        onClose={() => setOpen(false)}
        items={items}
        placement="bottom-end"
      />
      <input
        type="file"
        hidden
        accept=".txt,text/plain"
        data-testid="wl-import-input"
        aria-label="Import watchlist file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importFile(file);
        }}
      />
    </div>
  );
}
