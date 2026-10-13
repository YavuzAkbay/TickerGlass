import { Check, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { formatShortcut } from '../commands/registry';
import { Popover } from './Popover';

export type MenuItem =
  | {
      type?: 'item';
      label: string;
      icon?: ComponentType<{ size?: number }>;
      shortcut?: string;
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      onSelect?: () => void;
      submenu?: MenuItem[];
    }
  | { type: 'separator' }
  | { type: 'header'; label: string }
  | { type: 'custom'; render: (close: () => void) => ReactNode };

interface Props {
  items: MenuItem[];
  onClose: () => void;
  /** Focus the menu for keyboard navigation on mount. */
  autoFocus?: boolean;
}

/** Keyboard-navigable menu list with checkmarks, shortcuts and submenus. */
export function Menu({ items, onClose, autoFocus = true }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(-1);
  const [openSub, setOpenSub] = useState<{ index: number; el: HTMLElement } | null>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const hasIcons = items.some((it) => (it.type === undefined || it.type === 'item') && it.icon);

  const selectable = (i: number) => {
    const it = items[i];
    return !!it && (it.type === undefined || it.type === 'item') && !it.disabled;
  };

  const move = (dir: 1 | -1) => {
    let i = active;
    for (let n = 0; n < items.length; n++) {
      i = (i + dir + items.length) % items.length;
      if (selectable(i)) {
        setActive(i);
        return;
      }
    }
  };

  const activate = (i: number) => {
    const it = items[i];
    if (!it || (it.type && it.type !== 'item') || it.disabled) return;
    if (it.submenu) {
      const el = rowRefs.current[i];
      if (el) setOpenSub({ index: i, el });
      return;
    }
    it.onSelect?.();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="io-menu"
      role="menu"
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') move(1);
        else if (e.key === 'ArrowUp') move(-1);
        else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') activate(active);
        else if (e.key === 'ArrowLeft') onClose();
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {items.map((it, i) => {
        if (it.type === 'separator') return <div key={i} className="io-menu-sep" />;
        if (it.type === 'header')
          return (
            <div key={i} className="io-menu-header">
              {it.label}
            </div>
          );
        if (it.type === 'custom') return <div key={i}>{it.render(onClose)}</div>;
        const Icon = it.icon;
        return (
          <div
            key={i}
            ref={(el) => {
              rowRefs.current[i] = el;
            }}
            role="menuitem"
            aria-disabled={it.disabled}
            className={`io-menu-item${active === i ? ' active' : ''}${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}`}
            onPointerEnter={(e) => {
              setActive(i);
              setOpenSub(it.submenu ? { index: i, el: e.currentTarget } : null);
            }}
            onClick={() => activate(i)}
          >
            <span className="io-menu-check">{it.checked ? <Check size={14} /> : null}</span>
            {Icon || hasIcons ? (
              <span className="io-menu-icon">{Icon ? <Icon size={16} /> : null}</span>
            ) : null}
            <span className="io-menu-label">{it.label}</span>
            {it.shortcut ? (
              <span className="io-menu-shortcut">{formatShortcut(it.shortcut)}</span>
            ) : null}
            {it.submenu ? <ChevronRight size={14} className="io-menu-arrow" /> : null}
            {it.submenu && openSub?.index === i ? (
              <Popover
                anchor={openSub.el}
                open
                placement="right-start"
                onClose={() => setOpenSub(null)}
              >
                <Menu
                  items={it.submenu}
                  autoFocus={false}
                  onClose={() => {
                    setOpenSub(null);
                    onClose();
                  }}
                />
              </Popover>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface DropdownProps {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
  placement?: 'bottom-start' | 'bottom-end' | 'right-start';
}

/** Menu in a popover anchored to a button. */
export function DropdownMenu({ anchor, open, onClose, items, placement }: DropdownProps) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} placement={placement} ignore={[anchor]}>
      <Menu items={items} onClose={onClose} />
    </Popover>
  );
}
