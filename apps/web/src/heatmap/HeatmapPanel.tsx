import { SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import type { LiveQuote } from '../quotes/types';
import { fmtAuto, fmtCap, fmtCompact, fmtPrice, fmtSigned } from '../sidebar/format';
import { LEGEND_GRADIENT, divergingColor, scalePosition } from './color';
import { weightedMean } from './grouping';
import { useHeatmapPrefs } from './heatmapPrefs';
import { layoutGroups, DEFAULT_GROUP_LAYOUT, type GroupInput } from './layout';
import {
  COLOR_METRICS,
  COLOR_METRIC_IDS,
  SIZE_LABEL,
  SIZE_METRIC_IDS,
  isLiveSize,
  quantize,
  resolveSizes,
  sizeValue,
  sizesMoved,
  type HeatSymbol,
  type SizeMetricId,
} from './metrics';
import { Treemap, type GroupData, type TileData } from './Treemap';
import './heatmap.css';

/** Maps sized by volume or market cap re-lay out at most this often (ms), not on every tick. */
const LIVE_SIZE_INTERVAL_MS = 15_000;

export interface HeatmapPanelProps {
  symbols: readonly HeatSymbol[];
  quotes: Readonly<Record<string, LiveQuote | undefined>>;
  /** Tiles are grouped by `HeatSymbol.group` (otherwise one flat map). */
  grouped: boolean;
  /** Controls at the left of the toolbar (filter box, group-by select). */
  leading?: ReactNode;
  focus: string | null;
  onFocus: (symbol: string | null) => void;
  onOpen: (symbol: string) => void;
  onMenu: (symbol: string, x: number, y: number) => void;
  /** The chart's symbol. */
  current: string | null;
  /** Data is on its way (server scan / first quotes). */
  loading?: boolean;
  /** A failed load, shown instead of the map. */
  error?: string | null;
  onRetry?: () => void;
  emptyTitle: string;
  emptyText: string;
  /** Footnote (live subscription cap). */
  note?: string | null;
  /** Late-resolved name for the tooltip (watchlists resolve names lazily). */
  nameNode?: (symbol: string) => ReactNode;
  ariaLabel: string;
}

/** `value` held back to at most one update per `ms` while `enabled`. */
function useThrottled<T>(value: T, ms: number, enabled: boolean): T {
  const [held, setHeld] = useState(value);
  const latest = useRef(value);
  const lastAt = useRef(0);
  useEffect(() => {
    latest.current = value;
    if (!enabled) return;
    const id = setTimeout(
      () => {
        lastAt.current = Date.now();
        setHeld(latest.current);
      },
      Math.max(0, lastAt.current + ms - Date.now()),
    );
    return () => clearTimeout(id);
  }, [value, ms, enabled]);
  return enabled ? held : value;
}

function useElementSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const w = Math.floor(el.clientWidth);
      const h = Math.floor(el.clientHeight);
      setSize((s) => (s.w === w && s.h === h ? s : { w, h }));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);
  return [ref, size] as const;
}

function formatSize(metric: SizeMetricId, v: number | null): string {
  if (v === null) return fmtPrice(null);
  return metric === 'marketCap' || metric === 'dollarVolume'
    ? fmtCap(v)
    : metric === 'volume'
      ? fmtCompact(v)
      : '1';
}

/** Toolbar (size / colour pickers, legend), the treemap, and the empty / error states. */
export function HeatmapPanel({
  symbols,
  quotes,
  grouped,
  leading,
  focus,
  onFocus,
  onOpen,
  onMenu,
  current,
  loading = false,
  error = null,
  onRetry,
  emptyTitle,
  emptyText,
  note,
  nameNode,
  ariaLabel,
}: HeatmapPanelProps) {
  const t = useT();
  const sizeBy = useHeatmapPrefs((s) => s.sizeBy);
  const colorBy = useHeatmapPrefs((s) => s.colorBy);
  const metric = COLOR_METRICS[colorBy];
  const [stageRef, stage] = useElementSize();

  // Sizes: from the live quote's market cap / snapshot / static cap. Quote-backed sizes (volume,
  // market cap) would move on every tick, so they are sampled, and the layout keeps the sizes it
  // was built on until one drifts by more than SIZE_HYSTERESIS (so tiles do not jump).
  const sizeQuotes = useThrottled(quotes, LIVE_SIZE_INTERVAL_MS, isLiveSize(sizeBy));
  const fresh = useMemo(() => {
    const sized = resolveSizes(sizeBy, symbols, sizeQuotes);
    return { sized, byId: new Map(symbols.map((s, i) => [s.symbol, sized.sizes[i]!])) };
  }, [sizeBy, symbols, sizeQuotes]);
  const [laid, setLaid] = useState({ sizeBy, byId: fresh.byId });
  let layoutSizes = laid.byId;
  if (laid.sizeBy !== sizeBy || sizesMoved(laid.byId, fresh.byId)) {
    layoutSizes = fresh.byId;
    setLaid({ sizeBy, byId: fresh.byId }); // adjusting state while rendering: React re-renders at once
  }
  const sized = fresh.sized;
  const model = useMemo(() => {
    const groupIds: string[] = [];
    const byGroup = new Map<string, GroupInput['items'][number][]>();
    symbols.forEach((s, i) => {
      const g = grouped ? s.group : '';
      let list = byGroup.get(g);
      if (!list) {
        list = [];
        byGroup.set(g, list);
        groupIds.push(g);
      }
      list.push({ id: s.symbol, value: quantize(layoutSizes.get(s.symbol) ?? sized.sizes[i]!) });
    });
    const groups: GroupInput[] = groupIds.map((id) => ({ id, items: byGroup.get(id)! }));
    // Layout identity: ids, groups and quantized sizes. Colours never enter it.
    const key = groups
      .map((g) => `${g.id}:${g.items.map((i) => `${i.id}=${i.value}`).join(',')}`)
      .join('|');
    return { groups, key };
  }, [symbols, sized, layoutSizes, grouped]);

  const layout = useMemo(
    () =>
      layoutGroups(
        model.groups,
        { x: 0, y: 0, w: stage.w, h: stage.h },
        DEFAULT_GROUP_LAYOUT,
        !grouped,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- model.key is the layout's identity
    [model.key, stage.w, stage.h, grouped],
  );

  // Colours and texts follow every tick; they are cheap and do not touch the layout.
  const bySymbol = useMemo(() => new Map(symbols.map((s) => [s.symbol, s])), [symbols]);
  const { tiles, groupData } = useMemo(() => {
    const tiles: Record<string, TileData> = {};
    const perGroup = new Map<string, { values: (number | null)[]; weights: number[] }>();
    symbols.forEach((s) => {
      const v = metric.read(s, quotes[s.symbol]);
      const text = v === null ? fmtPrice(null) : metric.format(v);
      tiles[s.symbol] = {
        fill: v === null ? null : divergingColor(scalePosition(v, metric.center, metric.range)),
        value: text,
        label: `${s.symbol}${s.name ? `, ${s.name}` : ''}, ${v === null ? t('hm.noData') : text}`,
        name: s.name,
      };
      if (grouped) {
        let g = perGroup.get(s.group);
        if (!g) {
          g = { values: [], weights: [] };
          perGroup.set(s.group, g);
        }
        g.values.push(v);
        // Raw size as the weight: a symbol without one counts for nothing (its display size is
        // only a floor so that the tile stays visible).
        g.weights.push(sized.equalFallback ? 1 : (sizeValue(sizeBy, s, quotes[s.symbol]) ?? 0));
      }
    });
    const groupData: Record<string, GroupData> = {};
    for (const [id, g] of perGroup) {
      const avg = weightedMean(g.values, g.weights);
      groupData[id] = {
        label: id || t('hm.ungrouped'),
        value: avg === null ? '' : metric.format(avg),
      };
    }
    return { tiles, groupData };
  }, [symbols, quotes, metric, grouped, sized, sizeBy, t]);

  const tip = (symbol: string): ReactNode => {
    const s = bySymbol.get(symbol);
    if (!s) return null;
    const q = quotes[symbol];
    const price = q?.last ?? (typeof s.snap?.last === 'number' ? s.snap.last : null);
    const day = COLOR_METRICS.change1d.read(s, q);
    const v = metric.read(s, q);
    return (
      <>
        <div className="hm-tip-head">
          <strong className="rs-num">{symbol}</strong>
          <span className="hm-tip-name">{nameNode ? nameNode(symbol) : s.name}</span>
        </div>
        <dl className="hm-tip-grid">
          <dt>{t('hm.tip.price')}</dt>
          <dd className="rs-num">{fmtAuto(price)}</dd>
          <dt>{t('hm.tip.change')}</dt>
          <dd className="rs-num">{day === null ? fmtPrice(null) : fmtSigned(day, 2, '%')}</dd>
          {colorBy !== 'change1d' ? (
            <>
              <dt>{t(metric.label)}</dt>
              <dd className="rs-num">{v === null ? fmtPrice(null) : metric.format(v)}</dd>
            </>
          ) : null}
          <dt>{t(SIZE_LABEL[sizeBy])}</dt>
          <dd className="rs-num">
            {sized.equalFallback
              ? t('hm.tip.sizeNone')
              : formatSize(sizeBy, sizeValue(sizeBy, s, q))}
          </dd>
          {grouped && s.group ? (
            <>
              <dt>{t('hm.tip.group')}</dt>
              <dd>{s.group}</dd>
            </>
          ) : null}
        </dl>
      </>
    );
  };

  const empty = symbols.length === 0;
  return (
    <div className="hm-root" data-testid="hm-root">
      <div className="hm-toolbar">
        {leading}
        <label className="hm-field">
          <span>{t('hm.size')}</span>
          <select
            className="hm-select"
            data-testid="hm-size"
            value={sizeBy}
            onChange={(e) => useHeatmapPrefs.getState().setSizeBy(e.target.value as SizeMetricId)}
          >
            {SIZE_METRIC_IDS.map((id) => (
              <option key={id} value={id}>
                {t(SIZE_LABEL[id])}
              </option>
            ))}
          </select>
        </label>
        <label className="hm-field">
          <span>{t('hm.color')}</span>
          <select
            className="hm-select"
            data-testid="hm-color"
            value={colorBy}
            onChange={(e) =>
              useHeatmapPrefs.getState().setColorBy(e.target.value as typeof colorBy)
            }
          >
            {COLOR_METRIC_IDS.map((id) => (
              <option key={id} value={id}>
                {t(COLOR_METRICS[id].label)}
              </option>
            ))}
          </select>
        </label>
        <span className="hm-spacer" />
        <div
          className="hm-legend"
          data-testid="hm-legend"
          role="img"
          aria-label={t('hm.legend', {
            metric: t(metric.label),
            low: metric.ticks[0],
            high: metric.ticks[2],
          })}
        >
          <span className="hm-legend-bar" style={{ background: LEGEND_GRADIENT }} />
          <span className="hm-legend-ticks rs-num">
            <span>{metric.ticks[0]}</span>
            <span>{metric.ticks[1]}</span>
            <span>{metric.ticks[2]}</span>
          </span>
        </div>
      </div>
      <div className="hm-stage" ref={stageRef}>
        {error ? (
          <div className="hm-empty" role="alert" data-testid="hm-error">
            <SearchX size={30} strokeWidth={1.2} aria-hidden="true" />
            <div className="hm-empty-title">{error}</div>
            {onRetry ? (
              <button type="button" className="io-btn" onClick={onRetry}>
                {t('hm.retry')}
              </button>
            ) : null}
          </div>
        ) : empty ? (
          <div className="hm-empty" data-testid="hm-empty" role={loading ? 'status' : undefined}>
            <SearchX size={30} strokeWidth={1.2} aria-hidden="true" />
            <div className="hm-empty-title">{loading ? t('hm.loading') : emptyTitle}</div>
            {loading ? null : <div className="hm-empty-text">{emptyText}</div>}
          </div>
        ) : stage.w > 0 && stage.h > 0 ? (
          <Treemap
            layout={layout}
            width={stage.w}
            height={stage.h}
            tiles={tiles}
            groups={groupData}
            ariaLabel={ariaLabel}
            focus={focus}
            current={current}
            onFocus={onFocus}
            onOpen={onOpen}
            onMenu={onMenu}
            tip={tip}
          />
        ) : null}
      </div>
      {note || sized.equalFallback ? (
        <div className="hm-foot" data-testid="hm-foot">
          {sized.equalFallback ? <span>{t('hm.equalNote')}</span> : null}
          {note ? <span>{note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
