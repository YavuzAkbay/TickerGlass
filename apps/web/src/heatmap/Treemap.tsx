import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useLongPress } from '../ui/useLongPress';
import { neighbor, type GroupedLayout, type PlacedTile } from './layout';

/** What a tile shows (prepared by the panel; all strings are final). */
export interface TileData {
  /** CSS background; null = no value for the colour metric. */
  fill: string | null;
  /** Value text with its sign (never colour alone). */
  value: string;
  /** Full text for screen readers. */
  label: string;
  /** Company name for the largest tiles. */
  name: string;
}

export interface GroupData {
  label: string;
  /** Aggregate value text (cap-weighted), '' when unknown. */
  value: string;
}

interface Props {
  layout: GroupedLayout;
  width: number;
  height: number;
  tiles: Readonly<Record<string, TileData | undefined>>;
  groups: Readonly<Record<string, GroupData | undefined>>;
  ariaLabel: string;
  /** Keyboard / detail focus. */
  focus: string | null;
  /** The chart's symbol (subtle marker). */
  current: string | null;
  onFocus: (symbol: string | null) => void;
  onOpen: (symbol: string) => void;
  onMenu: (symbol: string, x: number, y: number) => void;
  /** Tooltip body for a symbol (hover, and the focused tile). */
  tip: (symbol: string) => ReactNode;
}

/** Tile text tiers by size (px). */
const MIN_W = 26;
const MIN_H = 16;

interface TileProps {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | null;
  value: string;
  label: string;
  name: string;
  active: boolean;
  current: boolean;
}

/** One rectangle; props are primitives so a colour tick re-renders only the tiles that changed. */
const Tile = memo(function Tile({
  id,
  x,
  y,
  w,
  h,
  fill,
  value,
  label,
  name,
  active,
  current,
}: TileProps) {
  const showText = w >= MIN_W && h >= MIN_H;
  const showValue = showText && h >= 34 && w >= 52;
  const showName = showValue && h >= 78 && w >= 120 && name !== '';
  // Font follows the tile: wide enough for the symbol, tall enough for two lines.
  const fs = Math.max(
    9,
    Math.min(
      28,
      w / Math.max(id.length * 0.72, showValue ? value.length * 0.5 : 0),
      h / (showValue ? 2.8 : 1.6),
    ),
  );
  const style: CSSProperties = {
    left: x,
    top: y,
    width: w,
    height: h,
    ...(fill ? { background: fill } : {}),
    fontSize: fs,
  };
  return (
    <div
      id={`hm-tile-${id}`}
      role="option"
      aria-selected={active}
      aria-label={label}
      data-sym={id}
      data-testid={`hm-tile-${id}`}
      className={`hm-tile${fill ? '' : ' nodata'}${active ? ' active' : ''}${current ? ' current' : ''}`}
      style={style}
    >
      {showText ? (
        <span className="hm-tile-in">
          <span className="hm-sym">{id}</span>
          {showValue ? <span className="hm-val rs-num">{value}</span> : null}
          {showName ? <span className="hm-name">{name}</span> : null}
        </span>
      ) : null}
    </div>
  );
});

/** Tooltip size estimate (px) for keeping it inside the map. */
const TIP_W = 230;
const TIP_H = 120;

/**
 * Pointer state outside React: the hovered symbol is a subscribable value (React re-renders only
 * when it changes), the pointer position is pushed to the tooltip element directly.
 */
class HoverStore {
  symbol: string | null = null;
  x = 0;
  y = 0;
  private symbolSubs = new Set<() => void>();
  private moveSubs = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.symbolSubs.add(fn);
    return () => void this.symbolSubs.delete(fn);
  };
  getSymbol = (): string | null => this.symbol;
  onMove = (fn: () => void): (() => void) => {
    this.moveSubs.add(fn);
    return () => void this.moveSubs.delete(fn);
  };

  set(symbol: string | null, x: number, y: number): void {
    const changed = symbol !== this.symbol;
    this.symbol = symbol;
    this.x = x;
    this.y = y;
    if (changed) this.symbolSubs.forEach((f) => f());
    else if (symbol !== null) this.moveSubs.forEach((f) => f());
  }
}

interface HoverTipProps {
  store: HoverStore;
  width: number;
  height: number;
  /** The keyboard-focused tile: explains itself when the pointer is elsewhere. */
  focusTile: PlacedTile | undefined;
  tip: (symbol: string) => ReactNode;
}

/** The tooltip. Re-renders when the hovered symbol changes; pointer moves only restyle it. */
function HoverTip({ store, width, height, focusTile, tip }: HoverTipProps) {
  const hovered = useSyncExternalStore(store.subscribe, store.getSymbol);
  const ref = useRef<HTMLDivElement>(null);
  const symbol = hovered ?? focusTile?.id ?? null;

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const at =
      store.symbol !== null
        ? { x: store.x, y: store.y }
        : focusTile
          ? { x: focusTile.x + 8, y: focusTile.y + focusTile.h - 4 }
          : null;
    if (!at) return;
    el.style.left = `${at.x + 14 + TIP_W > width ? Math.max(4, at.x - 14 - TIP_W) : at.x + 14}px`;
    el.style.top = `${at.y + 16 + TIP_H > height ? Math.max(4, at.y - 16 - TIP_H) : at.y + 16}px`;
  }, [store, focusTile, width, height]);

  useLayoutEffect(place);
  useLayoutEffect(() => store.onMove(place), [store, place]);

  if (symbol === null) return null;
  return (
    <div ref={ref} className="hm-tip" role="tooltip" data-testid="hm-tip">
      {tip(symbol)}
    </div>
  );
}

const symbolAt = (el: Element | null): string | null =>
  el?.closest<HTMLElement>('[data-sym]')?.dataset.sym ?? null;

/**
 * The tiles. Absolutely positioned divs (fine up to ~1000 tiles): the layout is computed by the
 * panel and only repainted here. One `listbox` that keeps DOM focus, with the active tile named by
 * `aria-activedescendant`, like the tables: arrows move between tiles, Enter opens, the context menu
 * key opens the row menu.
 */
export function Treemap({
  layout,
  width,
  height,
  tiles,
  groups,
  ariaLabel,
  focus,
  current,
  onFocus,
  onOpen,
  onMenu,
  tip,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [hover] = useState(() => new HoverStore());

  const order = layout.tiles;
  const focusTile = focus ? order.find((t) => t.id === focus) : undefined;

  const tileCenter = useCallback(
    (symbol: string): { x: number; y: number } | null => {
      const el = rootRef.current;
      const t = order.find((o) => o.id === symbol);
      if (!el || !t) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + t.x + t.w / 2, y: r.top + t.y + t.h / 2 };
    },
    [order],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey) return;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    const dir =
      e.key === 'ArrowLeft'
        ? 'left'
        : e.key === 'ArrowRight'
          ? 'right'
          : e.key === 'ArrowUp'
            ? 'up'
            : e.key === 'ArrowDown'
              ? 'down'
              : null;
    if (dir) {
      handled();
      if (!focusTile) {
        if (order[0]) onFocus(order[0].id);
        return;
      }
      const next = neighbor(order, focusTile.id, dir);
      if (next) onFocus(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      handled();
      const t = e.key === 'Home' ? order[0] : order[order.length - 1];
      if (t) onFocus(t.id);
    } else if (e.key === 'Enter') {
      handled();
      if (focusTile) onOpen(focusTile.id);
    } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      handled();
      const c = focusTile ? tileCenter(focusTile.id) : null;
      if (focusTile && c) onMenu(focusTile.id, c.x, c.y);
    }
  };

  const press = useLongPress((x, y) => {
    const symbol = symbolAt(document.elementFromPoint(x, y));
    if (symbol) {
      onFocus(symbol);
      onMenu(symbol, x, y);
    }
  });

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const symbol = symbolAt(e.target as Element);
    if (symbol) onFocus(symbol);
  };
  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    const symbol = symbolAt(e.target as Element);
    if (symbol) onOpen(symbol);
  };
  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    const symbol = symbolAt(e.target as Element);
    if (!symbol) return;
    e.preventDefault();
    onFocus(symbol);
    onMenu(symbol, e.clientX, e.clientY);
  };

  // Hover tooltip: native listeners feeding the store. The map itself never re-renders for a
  // pointer move; only the tooltip does, and only when the hovered symbol changes.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const symbol = symbolAt(e.target as Element);
      const r = el.getBoundingClientRect();
      hover.set(symbol, e.clientX - r.left, e.clientY - r.top);
    };
    const leave = () => hover.set(null, 0, 0);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, [hover]);

  const groupBoxes = useMemo(
    () =>
      layout.groups.filter(
        (g) =>
          layout.tiles.length > 0 &&
          g.rect.w > 0 &&
          g.rect.h > 0 &&
          (g.header || layout.groups.length > 1),
      ),
    [layout],
  );

  return (
    <div
      ref={rootRef}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-activedescendant={focusTile ? `hm-tile-${focusTile.id}` : undefined}
      data-testid="hm-map"
      className="hm-map"
      style={{ width, height }}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      onPointerDown={press.onPointerDown}
      onPointerMove={press.onPointerMove}
      onPointerUp={press.onPointerUp}
      onPointerCancel={press.onPointerCancel}
      onClickCapture={press.onClickCapture}
    >
      {groupBoxes.map((g) => (
        <div
          key={`g:${g.id}`}
          className="hm-group"
          data-testid={`hm-group-${g.id}`}
          style={{ left: g.rect.x, top: g.rect.y, width: g.rect.w, height: g.rect.h }}
        >
          {g.header ? (
            <div className="hm-group-head" style={{ height: g.header.h }}>
              <span className="hm-group-name">{groups[g.id]?.label ?? g.id}</span>
              {groups[g.id]?.value ? (
                <span className="hm-group-val rs-num">{groups[g.id]!.value}</span>
              ) : null}
            </div>
          ) : null}
        </div>
      ))}
      {order.map((t) => {
        const d = tiles[t.id];
        return (
          <Tile
            key={t.id}
            id={t.id}
            x={t.x}
            y={t.y}
            w={t.w}
            h={t.h}
            fill={d?.fill ?? null}
            value={d?.value ?? ''}
            label={d?.label ?? t.id}
            name={d?.name ?? ''}
            active={t.id === focus}
            current={t.id === current}
          />
        );
      })}
      <HoverTip store={hover} width={width} height={height} focusTile={focusTile} tip={tip} />
    </div>
  );
}
