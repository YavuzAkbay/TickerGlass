import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '../../i18n';
import { Modal } from '../../ui/Modal';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { sortedLists } from '../../watchlist/model';
import { useWatchlistStore } from '../../watchlist/store';
import { MAX_SYMBOLS, parseSymbolList, universeKey } from '../server/spec';
import type { ListInfo, Universe as ScanUniverse } from '../server/types';
import type { ScreenerClass, Universe } from '../universe/types';
import { ClassTabs } from './ClassTabs';

interface Props {
  value: ScanUniverse;
  onPick: (u: ScanUniverse) => void;
  loaded: Partial<Record<ScreenerClass, Universe>>;
  /** Server lists (`/screener/lists`). */
  lists: ListInfo[];
  /** Lists / watchlists / symbols need the server scan; false in client mode (class tabs only). */
  serverMode: boolean;
}

/** Class tabs plus, in server mode, a menu of index lists, watchlists and pasted symbols. */
export function UniversePicker({ value, onPick, loaded, lists, serverMode }: Props) {
  const t = useT();
  const [btn, setBtn] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pasting, setPasting] = useState(false);
  const watchlists = useWatchlistStore((s) => s.lists);

  const label = useMemo(() => {
    switch (value.kind) {
      case 'list':
        return lists.find((l) => l.id === value.id)?.name ?? value.id;
      case 'watchlist':
        return watchlists[value.id]?.name ?? t('scr.uni.watchlist');
      case 'symbols':
        return t('scr.uni.symbolsN').replace('{n}', String(value.symbols.length));
      default:
        return t('scr.uni.more');
    }
  }, [value, lists, watchlists, t]);

  const items: MenuItem[] = useMemo(() => {
    const out: MenuItem[] = [];
    if (lists.length) {
      out.push({ type: 'header', label: t('scr.uni.lists') });
      for (const l of lists)
        out.push({
          label: `${l.name} (${l.count})`,
          checked: universeKey(value) === `list:${l.id}`,
          onSelect: () => onPick({ kind: 'list', id: l.id }),
        });
      out.push({ type: 'separator' });
    }
    const mine = sortedLists(watchlists);
    out.push({
      label: t('scr.uni.watchlists'),
      disabled: mine.length === 0,
      submenu: mine.map((w) => ({
        label: w.name,
        checked: universeKey(value) === `watchlist:${w.id}`,
        onSelect: () => onPick({ kind: 'watchlist', id: w.id }),
      })),
    });
    out.push({ label: t('scr.uni.symbols'), onSelect: () => setPasting(true) });
    return out;
  }, [lists, watchlists, value, onPick, t]);

  return (
    <>
      <ClassTabs
        active={value.kind === 'class' ? value.cls : null}
        onPick={(cls) => onPick({ kind: 'class', cls })}
        loaded={loaded}
      >
        {serverMode ? (
          <>
            <span className="scr-tabs-spacer" />
            <button
              type="button"
              ref={setBtn}
              className={`scr-tab scr-uni-btn${value.kind !== 'class' ? ' on' : ''}`}
              aria-haspopup="menu"
              data-testid="scr-universe-btn"
              onClick={() => setOpen((o) => !o)}
            >
              {label}
              <ChevronDown size={12} aria-hidden="true" />
            </button>
            <DropdownMenu
              anchor={btn}
              open={open}
              onClose={() => setOpen(false)}
              items={items}
              placement="bottom-end"
            />
          </>
        ) : null}
      </ClassTabs>
      {pasting ? (
        <SymbolsDialog
          initial={value.kind === 'symbols' ? value.symbols.join(' ') : ''}
          onClose={() => setPasting(false)}
          onApply={(symbols) => {
            setPasting(false);
            onPick({ kind: 'symbols', symbols });
          }}
        />
      ) : null}
    </>
  );
}

function SymbolsDialog({
  initial,
  onClose,
  onApply,
}: {
  initial: string;
  onClose: () => void;
  onApply: (symbols: string[]) => void;
}) {
  const t = useT();
  const [text, setText] = useState(initial);
  const symbols = useMemo(() => parseSymbolList(text), [text]);
  const over = symbols.length > MAX_SYMBOLS;
  return (
    <Modal
      title={t('scr.uni.symbolsTitle')}
      onClose={onClose}
      width={420}
      footer={
        <>
          <div className="io-spacer" />
          <button type="button" className="io-btn" onClick={onClose}>
            {t('scr.cancel')}
          </button>
          <button
            type="button"
            className="io-btn io-btn-primary"
            data-testid="scr-symbols-apply"
            disabled={symbols.length === 0 || over}
            onClick={() => onApply(symbols)}
          >
            {t('scr.uni.apply')}
          </button>
        </>
      }
    >
      <textarea
        className="io-input scr-symbols-text"
        aria-label={t('scr.uni.symbolsTitle')}
        data-testid="scr-symbols-text"
        placeholder={t('scr.uni.symbolsHint')}
        autoFocus
        rows={6}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <div className={`scr-symbols-count${over ? ' over' : ''}`}>
        {t('scr.uni.symbolsCount')
          .replace('{n}', String(symbols.length))
          .replace('{max}', String(MAX_SYMBOLS))}
      </div>
    </Modal>
  );
}
