import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from './useMediaQuery';

export type Placement = 'bottom-start' | 'bottom-end' | 'right-start' | 'left-start' | 'top-start';

interface Props {
  /** Element to anchor to, or a fixed point (context menus). */
  anchor: HTMLElement | { x: number; y: number } | null;
  open: boolean;
  onClose: () => void;
  placement?: Placement | undefined;
  children: ReactNode;
  className?: string;
  /** Elements whose clicks don't count as "outside" (e.g. the trigger button). */
  ignore?: (HTMLElement | null)[];
  /** On phones render as a bottom action sheet (with a dimmed backdrop) instead of anchored. */
  sheet?: boolean;
}

let insetProbe: HTMLDivElement | null = null;
/** Current safe-area insets in px (0 where unsupported). */
function safeInsets(): { top: number; bottom: number; left: number; right: number } {
  if (!insetProbe) {
    insetProbe = document.createElement('div');
    insetProbe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  }
  if (!insetProbe.isConnected) document.body.appendChild(insetProbe);
  const cs = getComputedStyle(insetProbe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

/** Floating panel in a portal, positioned next to an anchor and kept on screen.
 * Closes on outside pointerdown and Escape. */
export function Popover({
  anchor,
  open,
  onClose,
  placement = 'bottom-start',
  children,
  className,
  ignore,
  sheet,
}: Props) {
  const mobile = useIsMobile();
  const asSheet = !!sheet && mobile;
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !ref.current || asSheet) return;
    const el = ref.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const inset = safeInsets();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left: number;
    let top: number;
    if ('getBoundingClientRect' in anchor) {
      const r = anchor.getBoundingClientRect();
      if (placement === 'right-start') {
        left = r.right + 4;
        top = r.top;
        if (left + w > vw) left = r.left - w - 4;
      } else if (placement === 'left-start') {
        left = r.left - w - 4;
        top = r.top;
        if (left < 0) left = r.right + 4;
      } else if (placement === 'top-start') {
        left = r.left;
        top = r.top - h - 4;
        if (top < 0) top = r.bottom + 4;
      } else {
        left = placement === 'bottom-end' ? r.right - w : r.left;
        top = r.bottom + 4;
        if (top + h > vh) top = r.top - h - 4;
      }
    } else {
      left = anchor.x;
      top = anchor.y;
      if (left + w > vw) left = anchor.x - w;
      if (top + h > vh) top = anchor.y - h;
    }
    setPos({
      left: Math.max(4 + inset.left, Math.min(left, vw - w - 4 - inset.right)),
      top: Math.max(4 + inset.top, Math.min(top, vh - h - 4 - inset.bottom)),
    });
  }, [open, anchor, placement, children, asSheet]);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (ignore?.some((el) => el?.contains(t))) return;
      // Clicks inside nested popovers (submenus) are portaled elsewhere.
      if ((t as HTMLElement).closest?.('.io-popover, .io-popover-backdrop')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => {
      // Elements marked data-own-escape (inline forms) handle Escape themselves.
      if ((e.target as HTMLElement | null)?.closest?.('[data-own-escape]')) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    const blur = () => onClose();
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', blur);
    };
  }, [open, onClose, ignore]);

  if (!open || !anchor) return null;
  return createPortal(
    <>
      {asSheet ? <div className="io-popover-backdrop" onClick={onClose} /> : null}
      <div
        ref={ref}
        className={`io-popover ${asSheet ? 'io-sheet ' : ''}${className ?? ''}`}
        style={
          asSheet ? undefined : pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }
        }
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
