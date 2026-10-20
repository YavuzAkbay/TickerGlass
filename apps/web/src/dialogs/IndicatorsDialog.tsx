import {
  USER_SCRIPT_PREFIX,
  getIndicator,
  isUserScriptType,
  listIndicators,
  scriptIdOf,
  isOutputRef,
  type AnyIndicatorDefinition,
  type IndicatorCategory,
  type OutputSourceRef,
} from '@investopen/indicators';
import {
  Activity,
  ArrowLeftRight,
  ChartColumn,
  ChartSpline,
  Code,
  Gauge,
  Landmark,
  Pencil,
  Plus,
  Search,
  Spline,
  Star,
  TrendingUp,
  Users,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addIndicator } from '../indicators/actions';
import { outputRefLabel, sourceInputKey } from '../indicators/model';
import { openScriptEditor } from '../indicators/menu';
import { useIndicatorPrefs, useIndicatorStore } from '../indicators/store';
import { useScriptsStore } from '../scripts/store';
import { Modal } from '../ui/Modal';
import '../indicators/indicators.css';
import './dialogs.css';

type CategoryId =
  'favorites' | 'scripts' | 'technicals' | IndicatorCategory | 'fundamentals' | 'community';

interface Category {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  empty: string;
}

const TECH_CATEGORIES: { id: IndicatorCategory; label: string; icon: LucideIcon }[] = [
  { id: 'movingAverage', label: 'Moving averages', icon: Spline },
  { id: 'trend', label: 'Trend', icon: TrendingUp },
  { id: 'momentum', label: 'Oscillators', icon: Activity },
  { id: 'volatility', label: 'Volatility', icon: Gauge },
  { id: 'bands', label: 'Bands & channels', icon: ArrowLeftRight },
  { id: 'volume', label: 'Volume', icon: ChartColumn },
  { id: 'other', label: 'Other', icon: Waves },
];

function groups(defs: AnyIndicatorDefinition[]): { title: string; items: Category[] }[] {
  const present = new Set(defs.map((d) => d.category));
  return [
    {
      title: 'Personal',
      items: [
        {
          id: 'favorites',
          label: 'Favorites',
          icon: Star,
          empty: 'Star an indicator to keep it here.',
        },
        {
          id: 'scripts',
          label: 'My scripts',
          icon: Code,
          empty: 'Your own scripts will be listed here.',
        },
      ],
    },
    {
      title: 'Built-ins',
      items: [
        {
          id: 'technicals',
          label: 'Technicals',
          icon: ChartSpline,
          empty: 'No indicators are registered.',
        },
        ...TECH_CATEGORIES.filter((c) => present.has(c.id)).map((c): Category => ({
          ...c,
          empty: 'No indicators in this category.',
        })),
        {
          id: 'fundamentals',
          label: 'Fundamentals',
          icon: Landmark,
          empty: 'Income statement, balance sheet and valuation metrics.',
        },
      ],
    },
    {
      title: 'Community',
      items: [
        {
          id: 'community',
          label: 'Community',
          icon: Users,
          disabled: true,
          empty: 'Community scripts are not planned yet.',
        },
      ],
    },
  ];
}

/** Case-insensitive match of every query word against name, short name, id and keywords. */
export function matchesQuery(def: AnyIndicatorDefinition, query: string): boolean {
  const hay = [def.name, def.shortName, def.id, ...(def.keywords ?? [])].join(' ').toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function sourceArg(arg: unknown): OutputSourceRef | null {
  const s = (arg as { sourceOf?: unknown } | undefined)?.sourceOf;
  return isOutputRef(s) ? s : null;
}

/** Indicator picker: search, categories, favourites; Enter/click adds to the chart. */
export default function IndicatorsDialog({ onClose, arg }: { onClose: () => void; arg?: unknown }) {
  const sourceOf = sourceArg(arg);
  const favorites = useIndicatorPrefs((s) => s.favorites);
  const toggleFavorite = useIndicatorPrefs((s) => s.toggleFavorite);
  const instances = useIndicatorStore((s) => s.instances);
  // Scripts changing (saved, deleted) re-registers their definitions: list again.
  const scripts = useScriptsStore((s) => s.scripts);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CategoryId>('technicals');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const all = listIndicators()
    .filter((d) => !sourceOf || (sourceInputKey(d) && !isUserScriptType(d.id)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nav = groups(all);
  const current = nav.flatMap((g) => g.items).find((c) => c.id === cat);
  const q = query.trim();
  let rows: AnyIndicatorDefinition[];
  if (q) rows = all.filter((d) => matchesQuery(d, q));
  else if (cat === 'favorites') rows = all.filter((d) => favorites.includes(d.id));
  else if (cat === 'technicals') rows = all;
  else if (cat === 'scripts') rows = all.filter((d) => isUserScriptType(d.id));
  else rows = all.filter((d) => d.category === cat);
  const idx = Math.max(0, Math.min(active, rows.length - 1));
  // Scripts that cannot run (no valid manifest) have no definition, but must stay reachable for editing.
  const broken =
    cat === 'scripts' && !q && !sourceOf
      ? scripts.filter((s) => !getIndicator(USER_SCRIPT_PREFIX + s.id))
      : [];

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${idx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const add = (def: AnyIndicatorDefinition) => {
    const id = sourceOf ? addIndicator(def.id, { sourceOf }) : addIndicator(def.id);
    // Indicator-on-indicator adds one; the plain picker stays open.
    if (id && sourceOf) onClose();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = rows.length;
    if (e.key === 'ArrowDown') setActive(n ? (idx + 1) % n : 0);
    else if (e.key === 'ArrowUp') setActive(n ? (idx - 1 + n) % n : 0);
    else if (e.key === 'Enter') {
      const d = rows[idx];
      if (d) add(d);
    } else return;
    e.preventDefault();
  };

  let body: ReactNode;
  if (rows.length === 0 && broken.length === 0) {
    const Icon = current?.icon ?? ChartSpline;
    body = (
      <div className="dlg-emptystate">
        <Icon size={40} strokeWidth={1.2} className="dlg-emptystate-icon" />
        <h3>{q ? `No results for "${q}"` : (current?.label ?? '')}</h3>
        <p>{q ? 'Try another name or abbreviation.' : current?.empty}</p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="dlg-section-title">{q ? 'Search results' : current?.label}</div>
        {rows.map((d, i) => {
          const fav = favorites.includes(d.id);
          return (
            <div
              key={d.id}
              data-index={i}
              role="option"
              aria-selected={i === idx}
              className={`ind-row${i === idx ? ' active' : ''}`}
              onPointerEnter={() => setActive(i)}
              onClick={() => add(d)}
            >
              <button
                type="button"
                className={`ind-star${fav ? ' on' : ''}`}
                aria-label={fav ? `Remove ${d.name} from favorites` : `Add ${d.name} to favorites`}
                aria-pressed={fav}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(d.id);
                }}
              >
                <Star size={16} fill={fav ? 'currentColor' : 'none'} />
              </button>
              <span className="ind-row-name">{d.name}</span>
              <span className="ind-row-short">{d.shortName}</span>
              {isUserScriptType(d.id) ? (
                <button
                  type="button"
                  className="ind-edit"
                  aria-label={`Edit script ${d.name}`}
                  title="Edit script"
                  onClick={(e) => {
                    e.stopPropagation();
                    openScriptEditor(scriptIdOf(d.id));
                  }}
                >
                  <Pencil size={15} />
                </button>
              ) : null}
            </div>
          );
        })}
        {broken.map((s) => (
          <div key={s.id} className="ind-row-broken">
            <span className="ind-row-name">{s.name}</span>
            <span className="ind-row-short">has errors</span>
            <button
              type="button"
              className="ind-edit"
              aria-label={`Edit script ${s.name}`}
              title="Edit script"
              onClick={() => openScriptEditor(s.id)}
            >
              <Pencil size={15} />
            </button>
          </div>
        ))}
      </>
    );
  }

  return (
    <Modal
      title={sourceOf ? 'Add indicator on' : 'Indicators, metrics and strategies'}
      onClose={onClose}
      width={760}
      className="dlg-picker"
    >
      <div className="dlg-search dlg-search-boxed">
        <Search size={16} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          className="dlg-search-input"
          value={query}
          placeholder="Search"
          aria-label="Search indicators"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {sourceOf ? (
        <div className="ind-picker-note">
          Source: {outputRefLabel(sourceOf, (id) => instances.find((i) => i.id === id))}
        </div>
      ) : null}
      <div className="dlg-picker-body">
        <nav className="dlg-side" aria-label="Indicator categories">
          {nav.map((g) => (
            <div key={g.title} className="dlg-side-group">
              <div className="dlg-side-title">{g.title}</div>
              {g.items.map((c) => {
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`dlg-side-item${cat === c.id && !q ? ' active' : ''}`}
                    aria-current={cat === c.id ? 'true' : undefined}
                    disabled={c.disabled}
                    onClick={() => {
                      setCat(c.id);
                      setQuery('');
                      setActive(0);
                    }}
                  >
                    <Icon size={18} strokeWidth={1.6} />
                    <span>{c.label}</span>
                    {c.disabled ? <span className="dlg-soon">Soon</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div
          ref={listRef}
          className="dlg-picker-content ind-list"
          role="listbox"
          aria-label="Indicators"
        >
          {cat === 'scripts' && !q && !sourceOf ? (
            <div className="ind-scripts-head">
              <button type="button" className="io-btn" onClick={() => openScriptEditor()}>
                <Plus size={14} />
                New script
              </button>
            </div>
          ) : null}
          {body}
        </div>
      </div>
    </Modal>
  );
}
