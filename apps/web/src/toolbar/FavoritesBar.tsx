import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../store/ui';
import { IconButton } from '../ui/IconButton';
import { findSticker, findTool, isToolAvailable, selectTool, UNAVAILABLE_HINT } from './tools';

const POS_KEY = 'tickerglass-favbar-pos';

function loadPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}

function clamp(el: HTMLElement, x: number, y: number) {
  const maxX = window.innerWidth - el.offsetWidth - 4;
  const maxY = window.innerHeight - el.offsetHeight - 4;
  return { x: Math.max(4, Math.min(x, maxX)), y: Math.max(4, Math.min(y, maxY)) };
}

function place(el: HTMLElement, x: number, y: number) {
  const p = clamp(el, x, y);
  el.style.left = `${p.x}px`;
  el.style.top = `${p.y}px`;
  return p;
}

/** Floating, draggable bar of favorite drawing tools over the chart. */
export function FavoritesBar() {
  const favorites = useUiStore((s) => s.favoriteTools);
  const activeTool = useUiStore((s) => s.activeTool);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  // Initial position: saved, else top-centre of the chart area.
  const attach = (el: HTMLDivElement | null) => {
    if (!el || el.dataset.placed) return;
    el.dataset.placed = '1';
    const saved = loadPos();
    if (saved) {
      place(el, saved.x, saved.y);
      return;
    }
    const area = document.querySelector('.chart-area')?.getBoundingClientRect();
    const x = area ? area.left + area.width / 2 - el.offsetWidth / 2 : window.innerWidth / 2;
    place(el, x, area ? area.top + 8 : 48);
  };

  return createPortal(
    <div ref={attach} className="lt-favbar" role="toolbar" aria-label="Favorite drawing tools">
      <div
        className="lt-favbar-grip"
        aria-hidden="true"
        onPointerDown={(e) => {
          const bar = e.currentTarget.parentElement;
          if (!bar) return;
          const r = bar.getBoundingClientRect();
          drag.current = { dx: e.clientX - r.left, dy: e.clientY - r.top };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const bar = e.currentTarget.parentElement;
          if (!drag.current || !bar) return;
          place(bar, e.clientX - drag.current.dx, e.clientY - drag.current.dy);
        }}
        onPointerUp={(e) => {
          const bar = e.currentTarget.parentElement;
          if (!drag.current || !bar) return;
          drag.current = null;
          const r = bar.getBoundingClientRect();
          try {
            localStorage.setItem(POS_KEY, JSON.stringify({ x: r.left, y: r.top }));
          } catch {
            // Storage full or disabled: position just isn't remembered.
          }
        }}
      >
        <svg width="6" height="14" viewBox="0 0 6 14">
          {[1.5, 5.5, 9.5, 13].map((y) => (
            <g key={y} fill="currentColor">
              <circle cx="1.5" cy={y - 0.5} r="1" />
              <circle cx="4.5" cy={y - 0.5} r="1" />
            </g>
          ))}
        </svg>
      </div>
      {favorites.map((id) => {
        const tool = findTool(id);
        const sticker = tool ? undefined : findSticker(id);
        if (!tool && !sticker) return null;
        const Icon = tool?.icon;
        const name = tool?.name ?? sticker?.name ?? id;
        const available = isToolAvailable(id);
        return (
          <IconButton
            key={id}
            label={available ? name : `${name} (${UNAVAILABLE_HINT.toLowerCase()})`}
            {...(tool?.shortcut && available ? { shortcut: tool.shortcut } : {})}
            tipSide="bottom"
            active={activeTool === id}
            className={`lt-favbar-btn${available ? '' : ' unavailable'}`}
            onClick={() => selectTool(id)}
          >
            {Icon ? <Icon /> : <span className="lt-glyph">{sticker?.glyph}</span>}
          </IconButton>
        );
      })}
    </div>,
    document.body,
  );
}
