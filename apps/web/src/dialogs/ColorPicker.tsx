import { useState } from 'react';
import { Popover } from '../ui/Popover';

/* Palette swatches are user-pickable data, not UI theme colours. */
const GRAYS = [
  '#ffffff',
  '#d1d4dc',
  '#b2b5be',
  '#9598a1',
  '#787b86',
  '#5d606b',
  '#434651',
  '#2a2e39',
  '#131722',
  '#000000',
];
const HUES = [
  '#e5484d',
  '#f2a93b',
  '#f2d03b',
  '#8bc34a',
  '#18a383',
  '#0fb5c9',
  '#4f6bed',
  '#8e5cf6',
  '#e8618c',
  '#7a8a99',
];

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const hex2 = (n: number) =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0');

/** Parse #rgb, #rrggbb or #rrggbbaa. */
export function parseColor(value: string): Rgba | null {
  const v = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(v)) {
    const [r, g, b] = [...v].map((c) => parseInt(c + c, 16));
    return { r: r ?? 0, g: g ?? 0, b: b ?? 0, a: 255 };
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(v)) {
    return {
      r: parseInt(v.slice(0, 2), 16),
      g: parseInt(v.slice(2, 4), 16),
      b: parseInt(v.slice(4, 6), 16),
      a: v.length === 8 ? parseInt(v.slice(6, 8), 16) : 255,
    };
  }
  return null;
}

/** #rrggbb when opaque, #rrggbbaa otherwise. */
export function formatColor({ r, g, b, a }: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a >= 255 ? '' : hex2(a)}`;
}

function mix(hex: string, target: number, t: number): string {
  const c = parseColor(hex);
  if (!c) return hex;
  const m = (x: number) => x + (target - x) * t;
  return formatColor({ r: m(c.r), g: m(c.g), b: m(c.b), a: 255 });
}

/** 10 columns: grays, vivid hues, then tints and shades of each hue. */
const PALETTE: string[][] = [
  GRAYS,
  ...[0.8, 0.6, 0.4, 0.2].map((t) => HUES.map((h) => mix(h, 255, t))),
  HUES,
  ...[0.25, 0.5].map((t) => HUES.map((h) => mix(h, 0, t))),
];

const sameRgb = (a: Rgba | null, b: Rgba | null) =>
  !!a && !!b && a.r === b.r && a.g === b.g && a.b === b.b;

interface SwatchProps {
  value: string;
  onChange: (color: string) => void;
  /** Accessible name, e.g. "Body up colour". */
  label: string;
  disabled?: boolean;
}

/** Colour swatch button that opens a palette + hex + opacity picker. */
export function ColorSwatch({ value, onChange, label, disabled }: SwatchProps) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={setAnchor}
        type="button"
        className={`cp-swatch${open ? ' open' : ''}`}
        aria-label={`${label}: ${value}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="cp-chip">
          <span style={{ background: value }} />
        </span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} ignore={[anchor]}>
        <ColorPanel value={value} onChange={onChange} label={label} />
      </Popover>
    </>
  );
}

function ColorPanel({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (c: string) => void;
  label: string;
}) {
  const current = parseColor(value);
  const [hex, setHex] = useState(() => (current ? formatColor({ ...current, a: 255 }) : value));
  const alpha = current?.a ?? 255;

  const pick = (base: string) => {
    const c = parseColor(base);
    if (!c) return;
    const next = formatColor({ ...c, a: alpha });
    setHex(formatColor({ ...c, a: 255 }));
    onChange(next);
  };

  return (
    <div className="cp-panel" role="dialog" aria-label={label}>
      <div className="cp-grid" role="listbox" aria-label="Palette">
        {PALETTE.map((row, ri) =>
          row.map((c) => {
            const selected = sameRgb(parseColor(c), current);
            return (
              <button
                key={`${ri}-${c}`}
                type="button"
                role="option"
                aria-selected={selected}
                aria-label={c}
                className={`cp-cell${selected ? ' selected' : ''}`}
                style={{ background: c }}
                onClick={() => pick(c)}
              />
            );
          }),
        )}
      </div>
      <div className="cp-row">
        <span className="cp-preview" aria-hidden="true">
          <span style={{ background: value }} />
        </span>
        <input
          className="io-input cp-hex"
          value={hex}
          aria-label="Hex colour"
          spellCheck={false}
          maxLength={7}
          onChange={(e) => {
            const v = e.target.value;
            setHex(v);
            const c = parseColor(v);
            if (c && /^#?[0-9a-f]{6}$/i.test(v.trim())) onChange(formatColor({ ...c, a: alpha }));
          }}
          onBlur={() => current && setHex(formatColor({ ...current, a: 255 }))}
        />
      </div>
      <label className="cp-opacity">
        <span>Opacity</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((alpha / 255) * 100)}
          aria-label="Opacity"
          onChange={(e) => {
            if (!current) return;
            onChange(
              formatColor({ ...current, a: Math.round((Number(e.target.value) / 100) * 255) }),
            );
          }}
        />
        <span className="cp-opacity-val">{Math.round((alpha / 255) * 100)}%</span>
      </label>
    </div>
  );
}
