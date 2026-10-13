import { isOutputRef } from '@investopen/indicators';
import { commands, type Command } from '../commands/registry';
import {
  addIndicator,
  removeAllIndicators,
  removeIndicator,
  toggleIndicatorVisible,
} from './actions';
import { openIndicatorSettings } from './menu';

const str = (arg: unknown): string | null => (typeof arg === 'string' && arg ? arg : null);

/**
 * Indicator commands (hidden from the palette; the Indicators dialog is the entry point).
 * `indicators.add` takes a type id or `{ type, sourceOf }`.
 */
export function registerIndicatorCommands(): () => void {
  const list: Command[] = [
    {
      id: 'indicators.add',
      title: 'Add indicator',
      hidden: true,
      run: (arg) => {
        const type = str(arg) ?? str((arg as { type?: unknown } | undefined)?.type);
        if (!type) return;
        const sourceOf = (arg as { sourceOf?: unknown } | undefined)?.sourceOf;
        if (isOutputRef(sourceOf)) addIndicator(type, { sourceOf });
        else addIndicator(type);
      },
    },
    {
      id: 'indicators.remove',
      title: 'Remove indicator',
      hidden: true,
      run: (arg) => {
        const id = str(arg);
        if (id) removeIndicator(id);
      },
    },
    {
      id: 'indicators.toggleVisible',
      title: 'Show/hide indicator',
      hidden: true,
      run: (arg) => {
        const id = str(arg);
        if (id) toggleIndicatorVisible(id);
      },
    },
    {
      id: 'indicators.settings',
      title: 'Indicator settings',
      hidden: true,
      run: (arg) => {
        const id = str(arg);
        if (id) openIndicatorSettings(id);
      },
    },
    {
      id: 'indicators.removeAll',
      title: 'Remove all indicators',
      category: 'Chart',
      run: removeAllIndicators,
    },
  ];
  return commands.register(list);
}
