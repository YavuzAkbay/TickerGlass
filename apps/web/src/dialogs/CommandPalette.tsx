import { listIndicators } from '@tickerglass/indicators';
import {
  AlarmClock,
  ArrowRightLeft,
  ChartCandlestick,
  ChevronRight,
  Clock,
  GitCompareArrows,
  Search,
  SquareFunction,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { openAlertDialog } from '../alerts/dialog/open';
import { addCompare } from '../compare/actions';
import {
  INTENT_EXAMPLES,
  parseIntents,
  type IndicatorInfo,
  type Intent,
} from '../commands/natural';
import { commands, formatShortcut, type Command } from '../commands/registry';
import { addIndicator } from '../indicators/actions';
import { useChartView } from '../store/chartView';
import { CHART_TYPE_MENU } from '../topbar/chartTypes';
import { intervalLabel } from '../topbar/intervals';
import { Modal } from '../ui/Modal';
import { useCommandList } from './useCommandList';
import './dialogs.css';

interface Match {
  score: number;
  /** Matched character positions in the title, for highlighting. */
  positions: number[];
}

/** Subsequence fuzzy match; rewards contiguous runs and word starts. */
function fuzzyMatch(text: string, query: string): Match | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, positions: [] };
  // Contiguous substring wins outright (greedy subsequence would grab the "l" in
  // "toggLe" and reject "log" -> "Toggle logarithmic scale" as scattered).
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[\s/]/.test(t[at - 1]!);
    return {
      score: q.length * 4 + (wordStart ? 6 : 0) - at * 0.05 - t.length * 0.01,
      positions: Array.from({ length: q.length }, (_, i) => at + i),
    };
  }
  const positions: number[] = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  let strong = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || t[found - 1] === ' ' || t[found - 1] === '/';
    const contiguous = found === prev + 1;
    if (contiguous || wordStart) strong++;
    score += 1 + (contiguous ? 3 : 0) + (wordStart ? 2 : 0);
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  // Scattered letters ("scale" in "Create alert") are noise, not matches.
  if (strong < Math.ceil(q.length / 2)) return null;
  // Prefer shorter titles and earlier first matches.
  score -= (positions[0] ?? 0) * 0.05 + t.length * 0.01;
  return { score, positions };
}

function renderHighlighted(text: string, positions: number[]): ReactNode {
  if (positions.length === 0) return text;
  const set = new Set(positions);
  const out: ReactNode[] = [];
  let buf = '';
  let marked = false;
  const flush = (key: number) => {
    if (!buf) return;
    out.push(marked ? <mark key={key}>{buf}</mark> : buf);
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== marked) {
      flush(i);
      marked = m;
    }
    buf += text[i];
  }
  flush(text.length);
  return out;
}

interface Entry {
  key: string;
  title: string;
  category: string;
  icon?: ComponentType<{ size?: number }> | undefined;
  shortcut: string;
  positions: number[];
  run: () => void;
}

function indicatorInfos(): IndicatorInfo[] {
  return listIndicators().map((d) => ({
    id: d.id,
    name: d.name,
    shortName: d.shortName,
    numeric: Object.entries(d.inputs).flatMap(([key, def]) =>
      def.kind === 'int' || def.kind === 'float'
        ? [
            {
              key,
              label: def.label,
              kind: def.kind,
              ...(def.min !== undefined ? { min: def.min } : {}),
              ...(def.max !== undefined ? { max: def.max } : {}),
            },
          ]
        : [],
    ),
  }));
}

const CHART_TYPES = CHART_TYPE_MENU.flatMap((t) => (t ? [{ id: t.id, label: t.label }] : []));

const ALERT_WORDS = {
  crossing: 'crosses',
  crossingUp: 'crosses above',
  crossingDown: 'crosses below',
  greater: 'is above',
  less: 'is below',
} as const;

/** A palette row for a typed command ("rsi 14", "4h", ...). */
function intentEntry(intent: Intent, exec: (fn: () => void) => void): Entry {
  const base = { category: 'Run', shortcut: '', positions: [] };
  switch (intent.kind) {
    case 'interval':
      return {
        ...base,
        key: `intent:interval:${intent.interval}`,
        title: `Switch to ${intervalLabel(intent.interval)}`,
        icon: Clock,
        run: () => exec(() => commands.execute('chart.setInterval', intent.interval)),
      };
    case 'indicator': {
      const values = Object.values(intent.inputs);
      return {
        ...base,
        key: `intent:indicator:${intent.type}:${values.join(',')}`,
        title: `Add ${intent.name}${values.length ? ` (${values.join(', ')})` : ''}`,
        icon: SquareFunction,
        run: () => exec(() => void addIndicator(intent.type, { inputs: intent.inputs })),
      };
    }
    case 'compare':
      return {
        ...base,
        key: `intent:compare:${intent.symbol}`,
        title: `Compare with ${intent.symbol}`,
        icon: GitCompareArrows,
        run: () => exec(() => void addCompare(intent.symbol, 'same')),
      };
    case 'alert':
      return {
        ...base,
        key: `intent:alert:${intent.op}:${intent.price}`,
        title: `Alert when price ${ALERT_WORDS[intent.op]} ${intent.price}`,
        icon: AlarmClock,
        run: () => exec(() => openAlertDialog({ price: intent.price, op: intent.op })),
      };
    case 'chartType':
      return {
        ...base,
        key: `intent:chartType:${intent.chartType}`,
        title: `Show as ${intent.label}`,
        icon: ChartCandlestick,
        run: () => exec(() => useChartView.getState().set({ chartType: intent.chartType })),
      };
  }
}

const TICKER_RE = /^[A-Za-z0-9^][A-Za-z0-9.=^-]{0,14}$/;

/** Mod+K palette: fuzzy search over every visible command, plus "Change symbol to X". */
export default function CommandPalette({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const all = useCommandList();
  const q = query.trim();

  const exec = (id: string, arg?: unknown) => {
    // Close first: the command may open another dialog.
    onClose();
    commands.execute(id, arg);
  };

  const matched = all
    .filter((c) => !c.hidden && commands.isEnabled(c.id))
    .map((c) => {
      const title = fuzzyMatch(c.title, q);
      const full = title ? null : fuzzyMatch(`${c.category ?? ''} ${c.title}`, q);
      const m = title ?? (full ? { score: full.score - 2, positions: [] } : null);
      return m ? { c, m } : null;
    })
    .filter((x): x is { c: Command; m: Match } => x !== null)
    .sort((a, b) =>
      q
        ? b.m.score - a.m.score
        : (a.c.category ?? '').localeCompare(b.c.category ?? '') ||
          a.c.title.localeCompare(b.c.title),
    );

  const intents = parseIntents(q, { indicators: indicatorInfos(), chartTypes: CHART_TYPES }).map(
    (i) =>
      intentEntry(i, (fn) => {
        onClose();
        fn();
      }),
  );

  const commandEntries: Entry[] = matched.map(({ c, m }) => ({
    key: c.id,
    title: c.title,
    category: c.category ?? 'General',
    icon: c.icon,
    shortcut: formatShortcut(c.shortcut),
    positions: m.positions,
    run: () => exec(c.id),
  }));
  // Typed commands are what the user spelled out: they lead.
  const entries: Entry[] = [...intents, ...commandEntries];

  if (TICKER_RE.test(q)) {
    const ticker = q.toUpperCase();
    const symbolEntry: Entry = {
      key: `symbol:${ticker}`,
      title: `Change symbol to ${ticker}`,
      category: 'Symbol',
      icon: ArrowRightLeft,
      shortcut: '',
      positions: [],
      run: () => exec('chart.setSymbol', ticker),
    };
    // A strong command match stays on top; otherwise the ticker jump leads.
    // "log" should find "Toggle logarithmic scale" before "Change symbol to LOG".
    const lower = q.toLowerCase();
    const wordHit = matched.some(({ c }) =>
      c.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .some((w) => w.startsWith(lower)),
    );
    const strong = intents.length > 0 || wordHit || (matched[0]?.m.score ?? 0) >= q.length * 3;
    if (strong) entries.push(symbolEntry);
    else entries.unshift(symbolEntry);
  }

  const idx = Math.max(0, Math.min(active, entries.length - 1));

  useEffect(() => {
    list.current?.querySelector('[data-active]')?.scrollIntoView({ block: 'nearest' });
  }, [idx, entries.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const n = entries.length;
    if (e.key === 'ArrowDown') setActive(n ? (idx + 1) % n : 0);
    else if (e.key === 'ArrowUp') setActive(n ? (idx - 1 + n) % n : 0);
    else if (e.key === 'PageDown') setActive(Math.min(n - 1, idx + 8));
    else if (e.key === 'PageUp') setActive(Math.max(0, idx - 8));
    else if (e.key === 'Enter') entries[idx]?.run();
    else return;
    e.preventDefault();
  };

  return (
    <Modal title="Command palette" onClose={onClose} width={580} top className="dlg-palette">
      <div className="dlg-search">
        <Search size={18} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          className="dlg-search-input"
          value={query}
          placeholder="Type a command, ticker or indicator…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded
          aria-controls="dlg-palette-list"
          aria-autocomplete="list"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <kbd className="dlg-esc">Esc</kbd>
      </div>
      <div ref={list} id="dlg-palette-list" className="dlg-list dlg-palette-list" role="listbox">
        {entries.length === 0 ? (
          <div className="dlg-empty">No commands match &ldquo;{q}&rdquo;</div>
        ) : (
          entries.map((e, i) => {
            const Icon = e.icon;
            return (
              <div
                key={e.key}
                role="option"
                aria-selected={i === idx}
                data-active={i === idx || undefined}
                className={`dlg-cmdrow${i === idx ? ' active' : ''}`}
                onPointerMove={() => setActive(i)}
                onClick={e.run}
              >
                <span className="dlg-cmdicon">
                  {Icon ? <Icon size={16} /> : <ChevronRight size={16} />}
                </span>
                <span className="dlg-cmdcat">{e.category}</span>
                <span className="dlg-cmdtitle">{renderHighlighted(e.title, e.positions)}</span>
                {e.shortcut ? <kbd className="dlg-kbd">{e.shortcut}</kbd> : null}
              </div>
            );
          })
        )}
      </div>
      <PaletteFooter
        onExample={(text) => {
          setQuery(text);
          setActive(0);
        }}
      />
    </Modal>
  );
}

/** Example commands to learn the grammar, plus the keys that drive the list. */
function PaletteFooter({ onExample }: { onExample: (text: string) => void }) {
  return (
    <div className="dlg-palette-foot">
      <span className="dlg-palette-try">Try</span>
      {INTENT_EXAMPLES.map((ex) => (
        <button
          key={ex}
          type="button"
          className="dlg-palette-example"
          onClick={() => onExample(ex)}
        >
          {ex}
        </button>
      ))}
      <span className="dlg-palette-keys">
        <kbd className="dlg-kbd">↑↓</kbd> move <kbd className="dlg-kbd">Enter</kbd> run
      </span>
    </div>
  );
}
