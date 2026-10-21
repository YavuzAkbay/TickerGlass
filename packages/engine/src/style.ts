import type { ChartTheme } from './options';

const STYLE_ID = 'tickerglass-engine-style';

const CSS = `
.io-chart { position: relative; overflow: hidden; user-select: none; -webkit-user-select: none;
  touch-action: none; outline: none; background: var(--io-bg); color: var(--io-text);
  font-family: var(--io-font); font-size: var(--io-font-size); }
.io-pane, .io-axis { position: absolute; overflow: hidden; }
.io-price-axis { border-left: 1px solid var(--io-border); box-sizing: border-box; }
.io-time-axis { border-top: 1px solid var(--io-border); box-sizing: border-box; }
.io-separator { position: absolute; height: 1px; background: var(--io-border); z-index: 5; }
.io-separator::after { content: ''; position: absolute; left: 0; right: 0; top: -3px; height: 7px;
  cursor: row-resize; }
.io-separator.io-active, .io-separator:hover { background: var(--io-text-muted); }
.io-legend { position: absolute; left: 8px; top: 6px; z-index: 4; pointer-events: none;
  line-height: 18px; white-space: nowrap; font-size: 13px; }
.io-legend-info:empty { display: none; }
.io-legend-compare, .io-legend-slot { pointer-events: auto; width: fit-content; }
.io-legend-title { color: var(--io-text); font-weight: 500; margin-right: 10px; }
.io-legend-item { margin-right: 8px; }
.io-legend-label { color: var(--io-text-muted); margin-right: 2px; }
.io-status { position: absolute; inset: 0; display: grid; place-items: center; z-index: 6;
  pointer-events: none; color: var(--io-text-muted); font-size: 14px; }
`;

export function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export function applyThemeVars(el: HTMLElement, t: ChartTheme): void {
  const vars: Record<string, string> = {
    '--io-bg': t.background,
    '--io-text': t.text,
    '--io-text-muted': t.textMuted,
    '--io-border': t.border,
    '--io-font': t.fontFamily,
    '--io-font-size': `${t.fontSize}px`,
  };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
}
