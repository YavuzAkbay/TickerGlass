import { SlidersHorizontal, Search, Settings2, X, Zap } from 'lucide-react';
import { useState, type RefObject } from 'react';
import { useT, type MessageKey } from '../../i18n';
import { DropdownMenu, type MenuItem } from '../../ui/Menu';
import { Popover } from '../../ui/Popover';
import {
  countFilters,
  invalidRanges,
  PAGE_SIZES,
  UNIVERSE_SIZES,
  type RangeFilter,
  type ScreenerFilters,
} from '../model';
import { PRESETS, type PresetId } from '../presets';
import { SCREENER_ALL_COLUMNS, useScreenerPrefs, type ScreenerColumnId } from '../screenerPrefs';
import type { Universe } from '../universe/types';
import { scrColumns } from './pageColumns';

/** Preset id → i18n key. */
const PRESET_KEYS: Record<PresetId, MessageKey> = {
  gainers: 'scr.presetGainers',
  losers: 'scr.presetLosers',
  movers: 'scr.presetMovers',
  active: 'scr.presetActive',
  volatile: 'scr.presetVolatile',
};

/** Finviz-style quick change bounds (± percent). */
const QUICK_CHG: readonly number[] = [1, 2, 5];

interface Props {
  universe: Universe;
  filters: ScreenerFilters;
  onFilters: (f: ScreenerFilters) => void;
  preset: PresetId | null;
  onPreset: (p: PresetId | null) => void;
  /** Ctrl/Cmd+F lands here. */
  searchRef: RefObject<HTMLInputElement | null>;
}

/** Toolbar of the screener: search, static filters, numeric filters, options. */
export function FilterBar({ universe, filters, onFilters, preset, onPreset, searchRef }: Props) {
  const t = useT();
  const cols = useScreenerPrefs((s) => s.columns);
  const density = useScreenerPrefs((s) => s.density);
  const sort = useScreenerPrefs((s) => s.sort);
  const pageSize = useScreenerPrefs((s) => s.pageSize);
  const universeSize = useScreenerPrefs((s) => s.universeSize);

  const [groupBtn, setGroupBtn] = useState<HTMLButtonElement | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const [exchBtn, setExchBtn] = useState<HTMLButtonElement | null>(null);
  const [exchOpen, setExchOpen] = useState(false);
  const [numOpen, setNumOpen] = useState(false);
  const [numBtn, setNumBtn] = useState<HTMLButtonElement | null>(null);
  const [optsBtn, setOptsBtn] = useState<HTMLButtonElement | null>(null);
  const [optsOpen, setOptsOpen] = useState(false);

  const columnDefs = scrColumns(universe);
  const groupLabel =
    universe.groupLabel === 'sector'
      ? t('scr.sector')
      : universe.groupLabel === 'category'
        ? t('scr.category')
        : t('scr.group');
  const numCount =
    countFilters(filters) -
    (filters.search.trim() ? 1 : 0) -
    (filters.group ? 1 : 0) -
    (filters.exchange ? 1 : 0);

  const groupItems: MenuItem[] = [
    {
      label: t('scr.all'),
      checked: filters.group === null,
      onSelect: () => onFilters({ ...filters, group: null }),
    },
    ...universe.groups.map((g): MenuItem => ({
      label: g,
      checked: filters.group === g,
      onSelect: () => onFilters({ ...filters, group: g }),
    })),
  ];

  const exchItems: MenuItem[] = [
    {
      label: t('scr.allExchanges'),
      checked: filters.exchange === null,
      onSelect: () => onFilters({ ...filters, exchange: null }),
    },
    ...universe.exchanges.map((e): MenuItem => ({
      label: e,
      checked: filters.exchange === e,
      onSelect: () => onFilters({ ...filters, exchange: e }),
    })),
  ];

  const optionsItems: MenuItem[] = [
    {
      label: t('scr.rows'),
      submenu: PAGE_SIZES.map((n): MenuItem => ({
        label: n === null ? t('scr.all') : String(n),
        checked: n === pageSize,
        onSelect: () => useScreenerPrefs.getState().setPageSize(n),
      })),
    },
    {
      label: t('scr.universe'),
      submenu: UNIVERSE_SIZES.map((n): MenuItem => ({
        label: n === null ? t('scr.universeAll') : t('scr.universeTop').replace('{n}', String(n)),
        checked: n === universeSize,
        onSelect: () => useScreenerPrefs.getState().setUniverseSize(n),
      })),
    },
    {
      label: t('scr.columns'),
      submenu: SCREENER_ALL_COLUMNS.map((id): MenuItem => ({
        label: columnDefs[id].title,
        checked: cols.includes(id),
        onSelect: () => useScreenerPrefs.getState().toggleColumn(id as ScreenerColumnId),
      })),
    },
    {
      label: t('scr.density'),
      submenu: (
        [
          ['compact', 'scr.densityCompact'],
          ['cozy', 'scr.densityCozy'],
        ] as const
      ).map(([d, key]): MenuItem => ({
        label: t(key),
        checked: density === d,
        onSelect: () => useScreenerPrefs.getState().setDensity(d),
      })),
    },
    { type: 'separator' },
    {
      label: t('scr.clearSort'),
      disabled: !sort,
      onSelect: () => useScreenerPrefs.getState().setSort(null),
    },
  ];

  const set = (patch: Partial<ScreenerFilters>) => onFilters({ ...filters, ...patch });

  return (
    <>
      <div className="scr-toolbar">
        <div className="scr-filter">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            value={filters.search}
            onChange={(e) => set({ search: e.target.value })}
            placeholder={t('scr.search')}
            aria-label={t('scr.search')}
            spellCheck={false}
            data-testid="scr-search"
          />
          {filters.search ? (
            <button
              type="button"
              className="scr-filter-clear"
              aria-label={t('scr.clearSearch')}
              onClick={() => {
                set({ search: '' });
                searchRef.current?.focus();
              }}
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        <button
          type="button"
          ref={setGroupBtn}
          className={`scr-drop${filters.group ? ' on' : ''}`}
          aria-haspopup="menu"
          data-testid="scr-group-btn"
          onClick={() => setGroupOpen((o) => !o)}
        >
          {filters.group ?? groupLabel}
        </button>
        <DropdownMenu
          anchor={groupBtn}
          open={groupOpen}
          onClose={() => setGroupOpen(false)}
          items={groupItems}
          placement="bottom-start"
        />

        {universe.exchanges.length > 1 ? (
          <>
            <button
              type="button"
              ref={setExchBtn}
              className={`scr-drop${filters.exchange ? ' on' : ''}`}
              aria-haspopup="menu"
              data-testid="scr-exchange-btn"
              onClick={() => setExchOpen((o) => !o)}
            >
              {filters.exchange ?? t('scr.exchange')}
            </button>
            <DropdownMenu
              anchor={exchBtn}
              open={exchOpen}
              onClose={() => setExchOpen(false)}
              items={exchItems}
              placement="bottom-start"
            />
          </>
        ) : null}

        <button
          type="button"
          ref={setNumBtn}
          className={`scr-tool-btn${numCount > 0 ? ' on' : ''}`}
          aria-haspopup="dialog"
          aria-label={t('scr.filters')}
          data-testid="scr-filters-btn"
          onClick={() => setNumOpen((o) => !o)}
        >
          <SlidersHorizontal size={14} strokeWidth={1.6} />
          {numCount > 0 ? <span className="scr-badge rs-num">{numCount}</span> : null}
        </button>
        <Popover
          anchor={numBtn}
          open={numOpen}
          onClose={() => setNumOpen(false)}
          placement="bottom-start"
          className="scr-numpop"
        >
          <NumFilters
            universe={universe}
            filters={filters}
            onFilters={onFilters}
            onClose={() => setNumOpen(false)}
          />
        </Popover>

        <span className="scr-toolbar-spacer" />

        <button
          type="button"
          ref={setOptsBtn}
          className="scr-tool-btn"
          aria-haspopup="menu"
          aria-label={t('scr.options')}
          data-testid="scr-options-btn"
          onClick={() => setOptsOpen((o) => !o)}
        >
          <Settings2 size={14} strokeWidth={1.6} />
        </button>
        <DropdownMenu
          anchor={optsBtn}
          open={optsOpen}
          onClose={() => setOptsOpen(false)}
          items={optionsItems}
          placement="bottom-end"
        />
      </div>

      {/* One-click screens (Finviz signals): a preset only sets the sort. */}
      <div
        className="scr-presets"
        role="group"
        aria-label={t('scr.presets')}
        data-testid="scr-presets"
      >
        <Zap size={12} strokeWidth={1.6} aria-hidden="true" className="scr-presets-label" />
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`scr-preset-chip${preset === p.id ? ' on' : ''}`}
            aria-pressed={preset === p.id}
            data-testid={`scr-preset-${p.id}`}
            onClick={() => onPreset(preset === p.id ? null : p.id)}
          >
            {t(PRESET_KEYS[p.id])}
          </button>
        ))}
      </div>
    </>
  );
}

/** Numeric min/max filters in a popover; commits on Enter or blur. */
function NumFilters({
  universe,
  filters,
  onFilters,
  onClose,
}: {
  universe: Universe;
  filters: ScreenerFilters;
  onFilters: (f: ScreenerFilters) => void;
  onClose: () => void;
}) {
  const t = useT();
  const set = (patch: Partial<ScreenerFilters>) => onFilters({ ...filters, ...patch });
  const capLabel = universe.capKind === 'mcap' ? t('scr.capMinMcap') : t('scr.capMinAum');
  const conflicts = invalidRanges(filters);
  const bad = (r: RangeFilter): boolean => conflicts.includes(r);
  // A quick chip replaces the opposite bound; say so before the click.
  const upClears = filters.chgMax !== null;
  const downClears = filters.chgMin !== null;
  const clearsTitle = (bound: string) => t('scr.quickClears').replace('{bound}', bound);
  return (
    <div className="scr-numfields" data-testid="scr-numfilters">
      <div className="scr-quick" role="group" aria-label={t('scr.quickChg')}>
        <span className="scr-quick-label">{t('scr.quickChg')}</span>
        {QUICK_CHG.map((n) => (
          <button
            key={n}
            type="button"
            className={`scr-quick-chip${filters.chgMin === n ? ' on' : ''}${upClears && filters.chgMin !== n ? ' clears' : ''}`}
            aria-pressed={filters.chgMin === n}
            title={
              upClears && filters.chgMin !== n
                ? clearsTitle(`${t('scr.chgMax')} ${filters.chgMax}%`)
                : undefined
            }
            data-testid={`scr-quick-up-${n}`}
            onClick={() => set({ chgMin: filters.chgMin === n ? null : n, chgMax: null })}
          >
            +{n}%
          </button>
        ))}
        {QUICK_CHG.map((n) => (
          <button
            key={-n}
            type="button"
            className={`scr-quick-chip${filters.chgMax === -n ? ' on' : ''}${downClears && filters.chgMax !== -n ? ' clears' : ''}`}
            aria-pressed={filters.chgMax === -n}
            title={
              downClears && filters.chgMax !== -n
                ? clearsTitle(`${t('scr.chgMin')} ${filters.chgMin}%`)
                : undefined
            }
            data-testid={`scr-quick-down-${n}`}
            onClick={() => set({ chgMax: filters.chgMax === -n ? null : -n, chgMin: null })}
          >
            −{n}%
          </button>
        ))}
      </div>
      <label>
        <span>{t('scr.priceMin')}</span>
        <NumInput
          value={filters.priceMin}
          invalid={bad('price')}
          onCommit={(v) => set({ priceMin: v })}
        />
      </label>
      <label>
        <span>{t('scr.priceMax')}</span>
        <NumInput
          value={filters.priceMax}
          invalid={bad('price')}
          onCommit={(v) => set({ priceMax: v })}
        />
      </label>
      <label>
        <span>{t('scr.chgMin')}</span>
        <NumInput
          value={filters.chgMin}
          invalid={bad('chg')}
          onCommit={(v) => set({ chgMin: v })}
          step={0.1}
        />
      </label>
      <label>
        <span>{t('scr.chgMax')}</span>
        <NumInput
          value={filters.chgMax}
          invalid={bad('chg')}
          onCommit={(v) => set({ chgMax: v })}
          step={0.1}
        />
      </label>
      <label>
        <span>{t('scr.volMin')}</span>
        <NumInput
          value={filters.volMin}
          invalid={bad('vol')}
          onCommit={(v) => set({ volMin: v })}
        />
      </label>
      <label>
        <span>{t('scr.volMax')}</span>
        <NumInput
          value={filters.volMax}
          invalid={bad('vol')}
          onCommit={(v) => set({ volMax: v })}
        />
      </label>
      <label>
        <span>{capLabel}</span>
        <NumInput value={filters.capMin} onCommit={(v) => set({ capMin: v })} />
      </label>
      {conflicts.length ? (
        <div className="scr-numerror" role="alert" data-testid="scr-range-error">
          {conflicts.map((r) => (
            <div key={r}>{t('scr.rangeConflict').replace('{filter}', RANGE_LABEL(t, r))}</div>
          ))}
        </div>
      ) : null}
      <div className="scr-numfields-foot">
        <button
          type="button"
          className="io-btn"
          onClick={() => {
            onFilters({
              ...filters,
              priceMin: null,
              priceMax: null,
              chgMin: null,
              chgMax: null,
              volMin: null,
              volMax: null,
              capMin: null,
            });
            onClose();
          }}
        >
          {t('scr.clearFilters')}
        </button>
        <button type="button" className="io-btn io-btn-primary" onClick={onClose}>
          {t('scr.done')}
        </button>
      </div>
    </div>
  );
}

const RANGE_LABEL = (t: (key: MessageKey) => string, r: RangeFilter): string =>
  t(r === 'price' ? 'scr.rangePrice' : r === 'chg' ? 'scr.rangeChg' : 'scr.rangeVol');

/** Number input that commits a parsed value (empty = no bound). */
function NumInput({
  value,
  onCommit,
  step,
  invalid,
}: {
  value: number | null;
  onCommit: (v: number | null) => void;
  step?: number;
  /** The pair this bound belongs to has min > max. */
  invalid?: boolean;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const commit = () => {
    const trimmed = text.trim();
    if (!trimmed) {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n === value) {
      setText(value === null ? '' : String(value));
      return;
    }
    onCommit(n);
  };
  return (
    <input
      className={`io-input scr-numinput rs-num${invalid ? ' invalid' : ''}`}
      aria-invalid={invalid || undefined}
      type="number"
      step={step}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          commit();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}
