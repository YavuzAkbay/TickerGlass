import {
  isEmbeddedImage,
  type AnyDrawingToolDefinition,
  type Drawing,
  type DrawingLevel,
  type DrawingProperty,
  type DrawingStyle,
  type JsonValue,
} from '@tickerglass/engine';
import { Plus, X } from 'lucide-react';
import { useRef } from 'react';
import { ColorSwatch } from '../dialogs/ColorPicker';
import { Check, Row, Section } from '../dialogs/controls';
import { NumberInput } from '../inspector/IndicatorSettings';
import { toast } from '../ui/Toast';
import { imageToDataUrl } from './image';
import { fitsImageBudget } from './per-drawing';
import { allDrawings, useDrawingStore } from './store';
import '../indicators/indicators.css';
import './drawings.css';
import '../dialogs/dialogs.css';

const LINE_STYLES: [string, string][] = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
];
const FONT_SIZES = [10, 11, 12, 14, 16, 20, 24, 28, 32, 40];

// ------------------------------------------------------------ properties

const str = (v: JsonValue | undefined, fallback: string) => (typeof v === 'string' ? v : fallback);
const num = (v: JsonValue | undefined, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

function isLevel(v: unknown): v is DrawingLevel {
  const o = v as DrawingLevel | null;
  return !!o && typeof o.value === 'number' && typeof o.color === 'string';
}

/** One control for a schema property. */
function PropertyControl({
  p,
  style,
  set,
  drawingId,
}: {
  p: DrawingProperty;
  style: DrawingStyle;
  set: (patch: DrawingStyle) => void;
  drawingId?: string | undefined;
}) {
  const v = style[p.key];
  switch (p.kind) {
    case 'color':
      return (
        <ColorSwatch
          value={str(v, '#6E9BD6')}
          label={p.label}
          onChange={(c) => set({ [p.key]: c })}
        />
      );
    case 'lineWidth':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={num(v, 1)}
          onChange={(e) => set({ [p.key]: Number(e.target.value) })}
        >
          {[1, 2, 3, 4].map((w) => (
            <option key={w} value={w}>
              {w}px
            </option>
          ))}
        </select>
      );
    case 'lineStyle':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={str(v, 'solid')}
          onChange={(e) => set({ [p.key]: e.target.value })}
        >
          {LINE_STYLES.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      );
    case 'fontSize':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={num(v, 14)}
          onChange={(e) => set({ [p.key]: Number(e.target.value) })}
        >
          {[...new Set([...FONT_SIZES, num(v, 14)])]
            .sort((x, y) => x - y)
            .map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
        </select>
      );
    case 'bool':
      return <Check checked={v === true} label={p.label} onChange={(b) => set({ [p.key]: b })} />;
    case 'number':
      return (
        <NumberInput
          value={num(v, 0)}
          min={p.min}
          max={p.max}
          step={p.step ?? 1}
          label={p.label}
          onChange={(n) =>
            set({
              [p.key]: Math.max(p.min ?? -Infinity, Math.min(p.max ?? Infinity, n)),
            })
          }
        />
      );
    case 'enum':
      return (
        <select
          className="io-input dlg-select"
          aria-label={p.label}
          value={str(v, p.options[0] ?? '')}
          onChange={(e) => set({ [p.key]: e.target.value })}
        >
          {p.options.map((o, i) => (
            <option key={o} value={o}>
              {p.labels?.[i] ?? o}
            </option>
          ))}
        </select>
      );
    case 'string':
      return (
        <input
          type="text"
          className="io-input"
          aria-label={p.label}
          maxLength={p.maxLength}
          value={str(v, '')}
          onChange={(e) => set({ [p.key]: e.target.value })}
        />
      );
    case 'image':
      return (
        <ImageField
          label={p.label}
          value={str(v, '')}
          drawingId={drawingId}
          onChange={(u) => set({ [p.key]: u })}
        />
      );
    case 'levels':
      return (
        <LevelsEditor
          levels={Array.isArray(v) ? v.filter(isLevel) : []}
          set={(levels) => set({ [p.key]: levels })}
        />
      );
  }
}

/** File picker + preview + remove for an `image` property (a downscaled data URL). */
function ImageField({
  label,
  value,
  drawingId,
  onChange,
}: {
  label: string;
  value: string;
  drawingId?: string | undefined;
  onChange: (dataUrl: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    try {
      const url = await imageToDataUrl(file);
      // All drawings share one localStorage key: cap the embedded images in total.
      if (!fitsImageBudget(allDrawings(useDrawingStore.getState()), drawingId, url)) {
        toast('Image storage full — remove an image drawing first', 'error');
        return;
      }
      onChange(url);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not load the image', 'error');
    }
  };
  return (
    <div className="drw-image">
      {value ? (
        isEmbeddedImage(value) ? (
          <img className="drw-image-preview" src={value} alt={`${label} preview`} />
        ) : (
          <div className="dlg-note">Image unavailable</div>
        )
      ) : null}
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="drw-image-input"
        aria-label={label}
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <button type="button" className="io-btn" onClick={() => input.current?.click()}>
        {value ? 'Replace' : 'Choose image'}
      </button>
      {value ? (
        <button type="button" className="io-btn" onClick={() => onChange('')}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

function LevelsEditor({
  levels,
  set,
}: {
  levels: DrawingLevel[];
  set: (levels: DrawingLevel[]) => void;
}) {
  const update = (i: number, patch: Partial<DrawingLevel>) =>
    set(levels.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="drw-levels">
      {levels.map((l, i) => (
        <div key={i} className="drw-level">
          <input
            type="checkbox"
            aria-label={`Level ${i + 1} visible`}
            checked={l.visible}
            onChange={(e) => update(i, { visible: e.target.checked })}
          />
          <NumberInput
            value={l.value}
            step={0.001}
            label={`Level ${i + 1} value`}
            onChange={(value) => update(i, { value })}
          />
          <ColorSwatch
            value={l.color}
            label={`Level ${i + 1} colour`}
            onChange={(color) => update(i, { color })}
          />
          <button
            type="button"
            className="io-icon-btn"
            aria-label={`Remove level ${i + 1}`}
            onClick={() => set(levels.filter((_, j) => j !== i))}
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <button
        type="button"
        className="io-btn drw-level-add"
        onClick={() =>
          set([
            ...levels,
            { value: (levels.at(-1)?.value ?? 0) + 0.5, color: '#A39E8F', visible: true },
          ])
        }
      >
        <Plus size={14} /> Add level
      </button>
    </div>
  );
}

/** Properties grouped into sections (`group`) and shared rows (`inline`), in schema order. */
export function PropertyList({
  props,
  style,
  set,
  drawingId,
}: {
  props: readonly DrawingProperty[];
  style: DrawingStyle;
  set: (patch: DrawingStyle) => void;
  drawingId?: string | undefined;
}) {
  if (!props.length) return <div className="dlg-note">Nothing to style.</div>;
  const sections: { title: string | undefined; rows: DrawingProperty[][] }[] = [];
  for (const p of props) {
    let sec = sections.at(-1);
    if (!sec || sec.title !== p.group) {
      sec = { title: p.group, rows: [] };
      sections.push(sec);
    }
    const row = sec.rows.at(-1);
    if (p.inline && row && row[0]!.inline === p.inline) row.push(p);
    else sec.rows.push([p]);
  }
  const renderRow = (row: DrawingProperty[]) => {
    const first = row[0]!;
    if (row.length === 1 && first.kind === 'bool')
      return (
        <div key={first.key} className="drw-prop-row">
          <PropertyControl p={first} style={style} set={set} drawingId={drawingId} />
        </div>
      );
    return (
      <Row key={first.key} label={first.label}>
        <div className="drw-inline">
          {row.map((p) => (
            <PropertyControl key={p.key} p={p} style={style} set={set} drawingId={drawingId} />
          ))}
        </div>
      </Row>
    );
  };
  return (
    <>
      {sections.map((s, i) =>
        s.title ? (
          <Section key={i} title={s.title}>
            {s.rows.map(renderRow)}
          </Section>
        ) : (
          <div key={i} className="dlg-section">
            {s.rows.map(renderRow)}
          </div>
        ),
      )}
    </>
  );
}

export function TextTab({
  def,
  draft,
  set,
  setStyle,
}: {
  def: AnyDrawingToolDefinition;
  draft: Drawing;
  set: (patch: Partial<Drawing>) => void;
  setStyle: (patch: DrawingStyle) => void;
}) {
  return (
    <>
      <PropertyList
        props={def.properties.filter((p) => p.tab === 'text')}
        style={draft.style}
        set={setStyle}
        drawingId={draft.id}
      />
      {def.text ? (
        <div className="dlg-section">
          {def.text.multiline ? (
            <textarea
              className="io-input drw-text-input"
              aria-label="Text"
              rows={5}
              value={draft.text}
              placeholder="Add text"
              onChange={(e) => set({ text: e.target.value })}
            />
          ) : (
            <input
              className="io-input drw-text-input"
              aria-label="Text"
              value={draft.text}
              placeholder="Add text"
              onChange={(e) => set({ text: e.target.value })}
            />
          )}
        </div>
      ) : null}
    </>
  );
}
