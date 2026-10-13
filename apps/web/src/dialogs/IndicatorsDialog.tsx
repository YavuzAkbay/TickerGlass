import { ChartSpline, Code, Search, Star, Users, Landmark, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '../ui/Modal';
import './dialogs.css';

type CategoryId = 'favorites' | 'technicals' | 'fundamentals' | 'community' | 'scripts';

interface Category {
  id: CategoryId;
  label: string;
  icon: LucideIcon;
  disabled?: boolean;
  empty: string;
}

const GROUPS: { title: string; items: Category[] }[] = [
  {
    title: 'Personal',
    items: [
      {
        id: 'favorites',
        label: 'Favorites',
        icon: Star,
        empty: 'Star an indicator to keep it here.',
      },
      {
        id: 'scripts',
        label: 'My scripts',
        icon: Code,
        empty: 'Your own scripts will be listed here.',
      },
    ],
  },
  {
    title: 'Built-ins',
    items: [
      {
        id: 'technicals',
        label: 'Technicals',
        icon: ChartSpline,
        empty: 'Moving averages, oscillators, volume and volatility studies.',
      },
      {
        id: 'fundamentals',
        label: 'Fundamentals',
        icon: Landmark,
        empty: 'Income statement, balance sheet and valuation metrics.',
      },
    ],
  },
  {
    title: 'Community',
    items: [
      {
        id: 'community',
        label: 'Community',
        icon: Users,
        disabled: true,
        empty: 'Community scripts are not planned yet.',
      },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items);

/** Shell of the indicator picker. Indicators themselves arrive in Phase 5. */
export default function IndicatorsDialog({ onClose }: { onClose: () => void; arg?: unknown }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<CategoryId>('technicals');
  const current = ALL.find((c) => c.id === cat);
  const q = query.trim();

  return (
    <Modal
      title="Indicators, metrics and strategies"
      onClose={onClose}
      width={760}
      className="dlg-picker"
    >
      <div className="dlg-search dlg-search-boxed">
        <Search size={16} strokeWidth={1.8} className="dlg-search-icon" />
        <input
          className="dlg-search-input"
          value={query}
          placeholder="Search"
          aria-label="Search indicators"
          spellCheck={false}
          autoComplete="off"
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="dlg-picker-body">
        <nav className="dlg-side" aria-label="Indicator categories">
          {GROUPS.map((g) => (
            <div key={g.title} className="dlg-side-group">
              <div className="dlg-side-title">{g.title}</div>
              {g.items.map((c) => {
                const Icon = c.icon;
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={`dlg-side-item${cat === c.id ? ' active' : ''}`}
                    aria-current={cat === c.id ? 'true' : undefined}
                    disabled={c.disabled}
                    onClick={() => setCat(c.id)}
                  >
                    <Icon size={18} strokeWidth={1.6} />
                    <span>{c.label}</span>
                    {c.disabled ? <span className="dlg-soon">Soon</span> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="dlg-picker-content">
          <div className="dlg-emptystate">
            <ChartSpline size={40} strokeWidth={1.2} className="dlg-emptystate-icon" />
            <h3>{q ? `No results for "${q}" yet` : `${current?.label ?? ''}`}</h3>
            <p>{current?.empty}</p>
            <p className="dlg-emptystate-phase">Indicators arrive in Phase 5.</p>
          </div>
        </div>
      </div>
    </Modal>
  );
}
