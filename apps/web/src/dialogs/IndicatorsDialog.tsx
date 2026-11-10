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
} from '@tickerglass/indicators';
import {
  Activity,
  ArrowLeftRight,
  ChartColumn,
  ChartSpline,
  Clock,
  Code,
  Gauge,
  Landmark,
  Pencil,
  Plus,
  Search,
  Spline,
  Star,
  TrendingUp,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addIndicator } from '../indicators/actions';
import { outputRefLabel, sourceInputKey } from '../indicators/model';
import { openScriptEditor } from '../indicators/menu';
import { useIndicatorPrefs, useIndicatorStore } from '../indicators/store';
import { useScriptsStore } from '../scripts/store';
import { Modal } from '../ui/Modal';
import '../indicators/indicators.css';
import './dialogs.css';

type CategoryId = 'starred' | 'custom' | 'builtin' | IndicatorCategory | 'financials';

interface Category {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  empty: string;
}

const TECH_CATEGORIES: { id: IndicatorCategory; label: string; icon: LucideIcon }[] = [
  { id: 'movingAverage', label: 'Moving averages', icon: Spline },
  { id: 'trend', label: 'Trend', icon: TrendingUp },
  { id: 'momentum', label: 'Momentum', icon: Activity },
  { id: 'volatility', label: 'Volatility', icon: Gauge },
  { id: 'bands', label: 'Envelopes & channels', icon: ArrowLeftRight },
  { id: 'volume', label: 'Volume', icon: ChartColumn },
  { id: 'other', label: 'Other', icon: Waves },
];

/** Section order + labels for grouped views (search, starred, recents). */
const CATEGORY_ORDER: IndicatorCategory[] = [
  'movingAverage',
  'trend',
  'momentum',
  'volatility',
  'bands',
  'volume',
  'other',
  'financials',
];
const CATEGORY_LABEL: Record<IndicatorCategory, string> = {
  movingAverage: 'Moving averages',
  trend: 'Trend',
  momentum: 'Momentum',
  volatility: 'Volatility',
  bands: 'Envelopes & channels',
  volume: 'Volume',
  other: 'Other',
  financials: 'Financials',
};

/** Recents pinned atop the All list. Fewer than the store cap to keep it a shortcut, not a list. */
const RECENTS_SHOWN = 6;

interface Section {
  key: string;
  title: string;
  icon?: LucideIcon;
  defs: AnyIndicatorDefinition[];
}

/** Groups defs by category, keeping the canonical category order. */
export function groupByCategory(defs: AnyIndicatorDefinition[]): Section[] {
  const byCat = new Map<IndicatorCategory, AnyIndicatorDefinition[]>();
  for (const d of defs) {
    const list = byCat.get(d.category);
    if (list) list.push(d);
    else byCat.set(d.category, [d]);
  }
  return CATEGORY_ORDER.filter((c) => byCat.has(c)).map((c) => ({
    key: c,
    title: CATEGORY_LABEL[c],
    defs: byCat.get(c)!,
  }));
}

/**
 * Sections for the current view: cross-category views (search, starred) group
 * under category headers; the recents shortcut sits atop the All list; single
 * categories stay flat (no headers).
 */
export function buildSections(opts: {
  q: string;
  cat: CategoryId;
  defs: AnyIndicatorDefinition[];
  recents: readonly string[];
}): Section[] {
  const { q, cat, defs, recents } = opts;
  if (q || cat === 'starred') return groupByCategory(defs);
  if (cat !== 'builtin') return [];
  const byId = new Map(defs.map((d) => [d.id, d]));
  const recentDefs = recents
    .map((t) => byId.get(t))
    .filter((d): d is AnyIndicatorDefinition => Boolean(d))
    .slice(0, RECENTS_SHOWN);
  if (recentDefs.length === 0) return [];
  const rest = defs.filter((d) => !recentDefs.some((r) => r.id === d.id));
  return [
    { key: 'recent', title: 'Recent', icon: Clock, defs: recentDefs },
    { key: 'all', title: 'All indicators', defs: rest },
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

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Marks query words inside `text`; with a capture group, odd split parts are matches. */
export function highlightMatch(text: string, words: string[]): ReactNode {
  if (words.length === 0) return text;
  const parts = text.split(new RegExp(`(${words.map(escapeRe).join('|')})`, 'ig'));
  if (parts.length === 1) return text;
  return parts.map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p));
}

function sourceArg(arg: unknown): OutputSourceRef | null {
  const s = (arg as { sourceOf?: unknown } | undefined)?.sourceOf;
  return isOutputRef(s) ? s : null;
}

/** Indicator picker: search, categories, favourites; Enter/click adds to the chart. */
export default function IndicatorsDialog({ onClose, arg }: { onClose: () => void; arg?: unknown }) {
  const sourceOf = sourceArg(arg);
  const favorites = useIndicatorPrefs((s) => s.favorites);
  const recents = useIndicatorPrefs((s) => s.recents);
  const toggleFavorite = useIndicatorPrefs((s) => s.toggleFavorite);
  const instances = useIndicatorStore((s) => s.instances);
  // Scripts changing (saved, deleted) re-registers their definitions: list again.
  const scripts = useScriptsStore((s) => s.scripts);
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CategoryId>('builtin');
  const [active, setActive] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const all = useMemo(
    () =>
      listIndicators()
        .filter((d) => !sourceOf || (sourceInputKey(d) && !isUserScriptType(d.id)))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [sourceOf],
  );
  const nav = useMemo(() => groups(all), [all]);

  // Instance count per type, for the "on chart" badge.
  const onChart = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of instances) m.set(i.type, (m.get(i.type) ?? 0) + 1);
    return m;
  }, [instances]);

  const q = query.trim();
  const words = useMemo(() => q.toLowerCase().split(/\s+/).filter(Boolean), [q]);

  const defs = useMemo(() => {
    if (q) return all.filter((d) => matchesQuery(d, q));
    if (cat === 'starred') return all.filter((d) => favorites.includes(d.id));
    if (cat === 'builtin') return all;
    if (cat === 'custom') return all.filter((d) => isUserScriptType(d.id));
    return all.filter((d) => d.category === cat);
  }, [q, cat, all, favorites]);

  // Cross-category views group results under sticky category headers; the recents
  // shortcut sits atop the All list. Flat views (single category, custom) need no headers.
  const sections: Section[] = useMemo(
    () => buildSections({ q, cat, defs, recents }),
    [q, cat, defs, recents],
  );

  // Flat rows for keyboard navigation: sections flattened, or the plain list.
  const rows = useMemo(
    () => (sections.length ? sections.flatMap((s) => s.defs) : defs),
    [sections, defs],
  );
  const rowIndex = useMemo(() => new Map(rows.map((d, i) => [d, i])), [rows]);
  const idx = Math.max(0, Math.min(active, rows.length - 1));
  // Scripts that cannot run (no valid manifest) have no definition, but must stay reachable for editing.
  const broken =
    cat === 'custom' && !q && !sourceOf
      ? scripts.filter((s) => !getIndicator(USER_SCRIPT_PREFIX + s.id))
      : [];

  const counts = useMemo(() => {
    const m = new Map<CategoryId, number>();
    m.set('builtin', all.length);
    for (const d of all) m.set(d.category, (m.get(d.category) ?? 0) + 1);
    m.set('starred', favorites.length);
    m.set('custom', all.filter((d) => isUserScriptType(d.id)).length);
    return m;
  }, [all, favorites]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${idx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const add = (def: AnyIndicatorDefinition) => {
    const id = sourceOf ? addIndicator(def.id, { sourceOf }) : addIndicator(def.id);
    // Indicator-on-indicator adds one; the plain picker stays open.
    if (id && sourceOf) onClose();
    else if (id) {
      setFlash(def.id);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), 900);
    }
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

  const current = nav.flatMap((g) => g.items).find((c) => c.id === cat);
  const sel = rows[idx] ?? null;
  const selFav = sel ? favorites.includes(sel.id) : false;

  let body: ReactNode;
  if (rows.length === 0 && broken.length === 0) {
    const Icon = current?.icon ?? ChartSpline;
    body = (
      <div className="dlg-emptystate">
        <Icon size={40} strokeWidth={1.2} className="dlg-emptystate-icon" />
        <h3>{q ? `No results for "${q}"` : (current?.label ?? '')}</h3>
        <p>{q ? 'Try another name or abbreviation.' : current?.empty}</p>
        {q ? (
          <button
            type="button"
            className="io-btn"
            onClick={() => {
              setQuery('');
              setActive(0);
              inputRef.current?.focus();
            }}
          >
            Clear search
          </button>
        ) : null}
      </div>
    );
  } else {
    body = (
      <>
        <div className="dlg-section-title">
          {q ? `Search results · ${rows.length}` : `${current?.label ?? ''} · ${rows.length}`}
        </div>
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <section key={s.key} className="ind-sec">
              <div className="ind-sec-head">
                {Icon ? <Icon size={12} strokeWidth={1.8} /> : null}
                {s.title}
                <span className="ind-sec-count">{s.defs.length}</span>
              </div>
              {s.defs.map((d) => (
                <Row
                  key={d.id}
                  def={d}
                  index={rowIndex.get(d) ?? 0}
                  active={rowIndex.get(d) === idx}
                  flash={flash === d.id}
                  fav={favorites.includes(d.id)}
                  onChart={onChart.get(d.id) ?? 0}
                  words={words}
                  onHover={setActive}
                  onAdd={add}
                  onToggleFavorite={toggleFavorite}
                />
              ))}
            </section>
          );
        })}
        {sections.length === 0
          ? defs.map((d) => (
              <Row
                key={d.id}
                def={d}
                index={rowIndex.get(d) ?? 0}
                active={rowIndex.get(d) === idx}
                flash={flash === d.id}
                fav={favorites.includes(d.id)}
                onChart={onChart.get(d.id) ?? 0}
                words={words}
                onHover={setActive}
                onAdd={add}
                onToggleFavorite={toggleFavorite}
              />
            ))
          : null}
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
      width={940}
      className="dlg-picker"
      dim={false}
    >
      <div className="dlg-search dlg-search-boxed">
        <Search size={16} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          ref={inputRef}
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
        {query ? (
          <button
            type="button"
            className="io-icon-btn dlg-clear"
            aria-label="Clear"
            onClick={() => {
              setQuery('');
              setActive(0);
              inputRef.current?.focus();
            }}
          >
            <X size={16} />
          </button>
        ) : null}
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
                const count = counts.get(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`dlg-side-item${cat === c.id && !q ? ' active' : ''}`}
                    aria-current={cat === c.id ? 'true' : undefined}
                    onClick={() => {
                      setCat(c.id);
                      setQuery('');
                      setActive(0);
                    }}
                  >
                    <Icon size={18} strokeWidth={1.6} />
                    <span>{c.label}</span>
                    {count ? <span className="dlg-side-count">{count}</span> : null}
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
          {cat === 'custom' && !q && !sourceOf ? (
            <div className="ind-scripts-head">
              <button type="button" className="io-btn" onClick={() => openScriptEditor()}>
                <Plus size={14} />
                New script
              </button>
            </div>
          ) : null}
          {body}
        </div>
        <DetailPane def={sel} fav={selFav} onAdd={add} onToggleFavorite={toggleFavorite} />
      </div>
      <div className="dlg-hints">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> add to chart
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </Modal>
  );
}

function groups(defs: AnyIndicatorDefinition[]): { title: string; items: Category[] }[] {
  const present = new Set(defs.map((d) => d.category));
  return [
    {
      title: 'Personal',
      items: [
        {
          id: 'starred',
          label: 'Starred',
          icon: Star,
          empty: 'Hover a row and click the star to keep it here.',
        },
        {
          id: 'custom',
          label: 'Custom',
          icon: Code,
          empty: 'Your own scripts will be listed here.',
        },
      ],
    },
    {
      title: 'Built-ins',
      items: [
        {
          id: 'builtin',
          label: 'All built-ins',
          icon: ChartSpline,
          empty: 'No indicators are registered.',
        },
        ...TECH_CATEGORIES.filter((c) => present.has(c.id)).map((c): Category => ({
          ...c,
          empty: 'No indicators in this category.',
        })),
        {
          id: 'financials',
          label: 'Financials',
          icon: Landmark,
          empty: 'Income statement, balance sheet and valuation metrics.',
        },
      ],
    },
  ];
}

interface RowProps {
  def: AnyIndicatorDefinition;
  index: number;
  active: boolean;
  flash: boolean;
  fav: boolean;
  onChart: number;
  words: string[];
  onHover: (index: number) => void;
  onAdd: (def: AnyIndicatorDefinition) => void;
  onToggleFavorite: (type: string) => void;
}

/** One picker row: star, name (query highlighted), on-chart badge, short name. */
function Row({
  def,
  index,
  active,
  flash,
  fav,
  onChart,
  words,
  onHover,
  onAdd,
  onToggleFavorite,
}: RowProps) {
  const script = isUserScriptType(def.id);
  return (
    <div
      data-index={index}
      role="option"
      aria-selected={active}
      className={`ind-row${active ? ' active' : ''}${flash ? ' ind-row-added' : ''}`}
      onPointerEnter={() => onHover(index)}
      onClick={() => onAdd(def)}
    >
      <button
        type="button"
        className={`ind-star${fav ? ' on' : ''}`}
        aria-label={fav ? `Remove ${def.name} from favorites` : `Add ${def.name} to favorites`}
        aria-pressed={fav}
        onClick={(e) => {
          e.stopPropagation();
          onToggleFavorite(def.id);
        }}
      >
        <Star size={16} fill={fav ? 'currentColor' : 'none'} />
      </button>
      <span className="ind-row-name">{highlightMatch(def.name, words)}</span>
      {onChart > 0 ? (
        <span className="ind-onchart" title={`${onChart} on chart`}>
          <span className="ind-onchart-dot" />
          {onChart}
        </span>
      ) : null}
      <span className="ind-row-short">{def.shortName}</span>
      {script ? (
        <button
          type="button"
          className="ind-edit"
          aria-label={`Edit script ${def.name}`}
          title="Edit script"
          onClick={(e) => {
            e.stopPropagation();
            openScriptEditor(scriptIdOf(def.id));
          }}
        >
          <Pencil size={15} />
        </button>
      ) : null}
    </div>
  );
}

interface DetailProps {
  def: AnyIndicatorDefinition | null;
  fav: boolean;
  onAdd: (def: AnyIndicatorDefinition) => void;
  onToggleFavorite: (type: string) => void;
}

/** Right pane previewing the highlighted indicator: description, placement, actions. */
function DetailPane({ def, fav, onAdd, onToggleFavorite }: DetailProps) {
  return (
    <aside className="ind-detail" aria-label="Indicator details">
      {def ? (
        <>
          <div className="ind-detail-body">
            <div className="ind-detail-head">
              <h3 className="ind-detail-name">{def.name}</h3>
              <span className="ind-detail-short">{def.shortName}</span>
            </div>
            <div className="ind-detail-meta">
              <span className="ind-detail-chip">{CATEGORY_LABEL[def.category]}</span>
              <span className="ind-detail-chip">
                {def.overlay ? 'Overlay on price' : 'Separate pane'}
              </span>
              {def.scaleRange ? (
                <span className="ind-detail-chip">
                  Fixed scale {def.scaleRange.min}–{def.scaleRange.max}
                </span>
              ) : null}
              {def.usesFundamentals ? (
                <span className="ind-detail-chip">Quarterly / annual data</span>
              ) : null}
            </div>
            <p className="ind-detail-desc">{def.description ?? 'No description yet.'}</p>
            {isUserScriptType(def.id) ? (
              <button
                type="button"
                className="io-btn ind-detail-edit"
                onClick={() => openScriptEditor(scriptIdOf(def.id))}
              >
                <Pencil size={14} />
                Edit script
              </button>
            ) : null}
          </div>
          <div className="ind-detail-foot">
            <button
              type="button"
              className={`ind-star ind-detail-star${fav ? ' on' : ''}`}
              aria-label={
                fav ? `Remove ${def.name} from favorites` : `Add ${def.name} to favorites`
              }
              aria-pressed={fav}
              onClick={() => onToggleFavorite(def.id)}
            >
              <Star size={16} fill={fav ? 'currentColor' : 'none'} />
            </button>
            <button
              type="button"
              className="io-btn io-btn-primary ind-detail-add"
              onClick={() => onAdd(def)}
            >
              Add to chart
            </button>
          </div>
        </>
      ) : (
        <div className="ind-detail-empty">Select an indicator to preview it here.</div>
      )}
    </aside>
  );
}
