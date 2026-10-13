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
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="dlg-row">
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

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <div className="dlg-segmented" role="radiogroup">
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
