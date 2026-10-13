import { forwardRef, type ComponentType, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { formatShortcut } from '../commands/registry';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon?: ComponentType<{ size?: number; strokeWidth?: number }>;
  /** Tooltip text (also the accessible label). */
  label: string;
  shortcut?: string;
  active?: boolean;
  size?: number;
  tipSide?: 'bottom' | 'right' | 'left' | 'top';
  children?: ReactNode;
}

/** Toolbar button with tooltip (CSS-driven via data-tip). */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  {
    icon: Icon,
    label,
    shortcut,
    active,
    size = 18,
    tipSide = 'bottom',
    children,
    className,
    ...rest
  },
  ref,
) {
  const tip = shortcut ? `${label}  ${formatShortcut(shortcut)}` : label;
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      data-tip={tip}
      data-tip-side={tipSide}
      className={`io-icon-btn${active ? ' active' : ''} ${className ?? ''}`}
      {...rest}
    >
      {Icon ? <Icon size={size} strokeWidth={1.6} /> : null}
      {children}
    </button>
  );
});
