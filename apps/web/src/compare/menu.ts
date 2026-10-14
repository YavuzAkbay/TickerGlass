import { Eye, EyeOff, Layers, Palette, Trash2 } from 'lucide-react';
import { createElement } from 'react';
import type { MenuItem } from '../ui/Menu';
import {
  findCompare,
  removeCompare,
  setComparePlacement,
  toggleCompareVisible,
  updateCompare,
} from './actions';
import { COMPARE_COLORS, PLACEMENTS, type ComparePlacement } from './model';

export const PLACEMENT_NAMES: Record<ComparePlacement, string> = {
  same: 'Same % scale',
  own: 'New price scale',
  pane: 'New pane',
};

const LINE_WIDTHS = [1, 2, 3, 4];

/** Legend "more" button and right-click menu of a compare overlay. */
export function compareMenuItems(id: string): MenuItem[] {
  const item = findCompare(id);
  if (!item) return [];
  return [
    {
      label: item.visible ? 'Hide' : 'Show',
      icon: item.visible ? EyeOff : Eye,
      onSelect: () => toggleCompareVisible(id),
    },
    { type: 'separator' },
    {
      label: 'Move to',
      icon: Layers,
      submenu: PLACEMENTS.map((p): MenuItem => ({
        label: PLACEMENT_NAMES[p],
        checked: item.placement === p,
        onSelect: () => {
          setComparePlacement(id, p);
        },
      })),
    },
    {
      label: 'Colour',
      icon: Palette,
      submenu: [
        {
          type: 'custom',
          render: (close) =>
            createElement(
              'div',
              { className: 'cmp-swatches' },
              COMPARE_COLORS.map((c) =>
                createElement('button', {
                  key: c,
                  type: 'button',
                  className: `cmp-swatch${item.color.toLowerCase() === c ? ' on' : ''}`,
                  style: { background: c },
                  'aria-label': `Colour ${c}`,
                  title: c,
                  onClick: () => {
                    updateCompare(id, { color: c }, 'Change compare colour');
                    close();
                  },
                }),
              ),
            ),
        },
      ],
    },
    {
      label: 'Line width',
      submenu: LINE_WIDTHS.map((w): MenuItem => ({
        label: `${w} px`,
        checked: item.lineWidth === w,
        onSelect: () => {
          updateCompare(id, { lineWidth: w }, 'Change compare line width');
        },
      })),
    },
    { type: 'separator' },
    { label: 'Remove', icon: Trash2, danger: true, onSelect: () => removeCompare(id) },
  ];
}
