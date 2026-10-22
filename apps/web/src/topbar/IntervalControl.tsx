import { ChevronDown, ChevronRight, Plus, Star, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { IntervalUnit } from '@tickerglass/engine';
import { commands } from '../commands/registry';
import { useAppStore } from '../store/app';
import { useChartView } from '../store/chartView';
import { Popover } from '../ui/Popover';
import {
  INTERVAL_GROUPS,
  UNIT_NAMES,
  canonicalInterval,
  intervalLabel,
  isBuiltinInterval,
  sameInterval,
  sortIntervals,
  unitOf,
} from './intervals';

const UNIT_SUFFIX: Record<IntervalUnit, string> = {
  minute: 'm',
  hour: 'h',
  day: 'D',
  week: 'W',
  month: 'M',
};

const setInterval = (iv: string) => commands.execute('chart.setInterval', iv);

/**
 * Favorite interval quick buttons plus the full interval dropdown. `compact`
 * shows only the active interval (a narrow bar).
 */
export function IntervalControl({ compact = false }: { compact?: boolean }) {
  const interval = useChartView((s) => s.interval);
  const favorites = useAppStore((s) => s.favoriteIntervals);
  const [open, setOpen] = useState(false);
  const [chevron, setChevron] = useState<HTMLButtonElement | null>(null);

  const favs = compact ? [] : sortIntervals(favorites);
  const activeIsFav = favs.some((f) => sameInterval(f, interval));

  return (
    <div className="tb-intervals" role="group" aria-label="Interval">
      {favs.map((iv) => (
        <button
          key={iv}
          type="button"
          className={`tb-btn tb-interval${sameInterval(iv, interval) ? ' active' : ''}`}
          aria-pressed={sameInterval(iv, interval)}
          data-tip={intervalLabel(iv)}
          data-tip-side="bottom"
          onClick={() => setInterval(iv)}
        >
          {iv}
        </button>
      ))}
      {!activeIsFav ? (
        <button
          type="button"
          className="tb-btn tb-interval active"
          aria-pressed
          data-tip={intervalLabel(interval)}
          data-tip-side="bottom"
          onClick={() => setOpen((o) => !o)}
        >
          {interval}
        </button>
      ) : null}
      <button
        ref={setChevron}
        type="button"
        className={`tb-btn tb-chevron${open ? ' open' : ''}`}
        aria-label="All intervals"
        aria-haspopup="menu"
        aria-expanded={open}
        data-tip={open ? undefined : 'All intervals'}
        data-tip-side="bottom"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronDown size={16} strokeWidth={1.6} />
      </button>
      <Popover anchor={chevron} open={open} onClose={() => setOpen(false)} ignore={[chevron]}>
        <IntervalMenu onClose={() => setOpen(false)} />
      </Popover>
    </div>
  );
}

function IntervalMenu({ onClose }: { onClose: () => void }) {
  const interval = useChartView((s) => s.interval);
  const favorites = useAppStore((s) => s.favoriteIntervals);
  const custom = useAppStore((s) => s.customIntervals);
  const toggleFavorite = useAppStore((s) => s.toggleFavoriteInterval);
  const removeCustom = useAppStore((s) => s.removeCustomInterval);
  const [collapsed, setCollapsed] = useState<Partial<Record<IntervalUnit, boolean>>>({});
  const [adding, setAdding] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  const isFav = (iv: string) => favorites.some((f) => sameInterval(f, iv));
  const choose = (iv: string) => {
    setInterval(iv);
    onClose();
  };

  // Arrow keys move focus between the focusable rows.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...(root.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [])];
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === 'ArrowDown' ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
    rows[next]?.focus();
    e.preventDefault();
  };

  return (
    <div ref={root} className="tb-ivmenu" role="menu" aria-label="Intervals" onKeyDown={onKeyDown}>
      {adding ? (
        <AddCustomInterval onDone={() => setAdding(false)} />
      ) : (
        <button
          type="button"
          className="tb-ivrow tb-ivadd"
          role="menuitem"
          data-row
          onClick={() => setAdding(true)}
        >
          <Plus size={16} strokeWidth={1.6} />
          <span>Add custom interval…</span>
        </button>
      )}
      {INTERVAL_GROUPS.map((g) => {
        const extra = custom.filter((c) => {
          const u = unitOf(c);
          return u !== null && g.units.includes(u) && !isBuiltinInterval(c);
        });
        const list = sortIntervals([...g.intervals, ...extra]);
        const isCollapsed = collapsed[g.unit] ?? false;
        return (
          <div key={g.unit} className="tb-ivgroup">
            <button
              type="button"
              className="tb-ivheader"
              aria-expanded={!isCollapsed}
              onClick={() => setCollapsed((c) => ({ ...c, [g.unit]: !isCollapsed }))}
            >
              <span>{g.title}</span>
              {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
            </button>
            {isCollapsed
              ? null
              : list.map((iv) => {
                  const active = sameInterval(iv, interval);
                  const fav = isFav(iv);
                  const isCustom = extra.includes(iv);
                  return (
                    <div
                      key={iv}
                      className={`tb-ivrow${active ? ' active' : ''}`}
                      role="menuitemradio"
                      aria-checked={active}
                      tabIndex={0}
                      data-row
                      ref={(el) => {
                        if (active && el && !root.current?.contains(document.activeElement)) {
                          el.focus({ preventScroll: true });
                        }
                      }}
                      onClick={() => choose(iv)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          choose(iv);
                        }
                      }}
                    >
                      <span className="tb-ivlabel">{intervalLabel(iv)}</span>
                      {isCustom ? (
                        <button
                          type="button"
                          className="tb-ivicon tb-ivremove"
                          aria-label={`Remove ${intervalLabel(iv)}`}
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (fav) toggleFavorite(iv);
                            removeCustom(iv);
                          }}
                        >
                          <X size={14} />
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className={`tb-ivicon tb-ivstar${fav ? ' on' : ''}`}
                        aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
                        aria-pressed={fav}
                        tabIndex={-1}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(iv);
                        }}
                      >
                        <Star size={14} fill={fav ? 'currentColor' : 'none'} strokeWidth={1.6} />
                      </button>
                    </div>
                  );
                })}
          </div>
        );
      })}
    </div>
  );
}

const UNITS: IntervalUnit[] = ['minute', 'hour', 'day', 'week', 'month'];

function AddCustomInterval({ onDone }: { onDone: () => void }) {
  const addCustom = useAppStore((s) => s.addCustomInterval);
  const [count, setCount] = useState('1');
  const [unit, setUnit] = useState<IntervalUnit>('minute');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const iv = canonicalInterval(`${count.trim()}${UNIT_SUFFIX[unit]}`);
    if (!iv) {
      setError('Enter a whole number between 1 and 100000');
      return;
    }
    if (isBuiltinInterval(iv)) {
      setError(`${intervalLabel(iv)} is already in the list`);
      return;
    }
    addCustom(iv);
    onDone();
  };

  return (
    <form
      className="tb-ivform"
      data-own-escape
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          e.preventDefault();
          onDone();
        }
      }}
    >
      <div className="tb-ivform-row">
        <input
          className="io-input tb-ivcount"
          type="number"
          min={1}
          max={100000}
          step={1}
          inputMode="numeric"
          aria-label="Count"
          value={count}
          autoFocus
          onChange={(e) => {
            setCount(e.target.value);
            setError(null);
          }}
        />
        <select
          className="io-input tb-ivunit"
          aria-label="Unit"
          value={unit}
          onChange={(e) => {
            setUnit(e.target.value as IntervalUnit);
            setError(null);
          }}
        >
          {UNITS.map((u) => (
            <option key={u} value={u}>
              {UNIT_NAMES[u][1]}
            </option>
          ))}
        </select>
      </div>
      {error ? (
        <div className="tb-ivform-error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="tb-ivform-actions">
        <button type="button" className="io-btn tb-small-btn" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="io-btn io-btn-primary tb-small-btn">
          Add
        </button>
      </div>
    </form>
  );
}
