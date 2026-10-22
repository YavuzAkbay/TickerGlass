import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useIsMobile } from '../ui/useMediaQuery';
import './legendGroup.css';

/**
 * Legend rows of one pane. On phones two or more rows fold into a single count chip
 * ("Indicators 3") so they do not stack over the chart; a tap lists them.
 */
export function LegendGroup({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: ReactNode;
}) {
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  if (!mobile || count < 2) return <>{children}</>;
  return (
    <>
      <button
        type="button"
        className="lg-chip"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{open ? `Hide ${label.toLowerCase()}` : `${label} ${count}`}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open ? children : null}
    </>
  );
}
