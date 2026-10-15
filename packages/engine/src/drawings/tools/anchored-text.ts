import { defineDrawingTool } from '../registry';
import { text } from './text';

/** Free text pinned to the pane (does not move with the chart): `coords: 'pane'`,
 * otherwise identical to the Text tool (top-left at the anchor). */
export const anchoredText = defineDrawingTool({
  ...text,
  type: 'anchored-text',
  name: 'Anchored text',
  coords: 'pane',
});
