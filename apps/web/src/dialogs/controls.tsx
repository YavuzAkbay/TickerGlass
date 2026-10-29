import type { ReactNode } from 'react';

/* Shared form rows for settings-style dialogs (chart and indicator settings). */

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dlg-section">
      <h3 className="dlg-section-head">{title}</h3>
      {children}
    </section>
  );
}

export function Row({
  label,
  htmlFor,
  stacked,
  children,
}: {
  label: string;
  htmlFor?: string;
  /** Control on its own line under the label, full width (wide controls such as segmented). */
  stacked?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`dlg-row${stacked ? ' dlg-row-stacked' : ''}`}>
      {htmlFor ? (
        <label className="dlg-row-label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="dlg-row-label">{label}</span>
      )}
      <div className="dlg-row-control">{children}</div>
    </div>
  );
}

export function Check({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="dlg-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** One boolean setting: checkbox, label and an optional one-line explanation. */
export function Setting({
  checked,
  label,
  hint,
  disabled,
  onChange,
}: {
  checked: boolean;
  label: string;
  hint?: string;
  /** Not available (e.g. the data provider lacks it); `hint` should say why. */
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      className={`dlg-setting${disabled ? ' disabled' : ''}`}
      title={disabled ? hint : undefined}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="dlg-setting-text">
        <span>{label}</span>
        {hint ? <span className="dlg-setting-hint">{hint}</span> : null}
      </span>
    </label>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  fill,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  /** Stretch to the container with equal-width options. */
  fill?: boolean;
}) {
  return (
    <div className={`dlg-segmented${fill ? ' dlg-segmented-fill' : ''}`} role="radiogroup">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          className={value === v ? 'active' : ''}
          onClick={() => onChange(v)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
