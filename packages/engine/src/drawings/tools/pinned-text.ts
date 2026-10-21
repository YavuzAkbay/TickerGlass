import { defineDrawingTool } from '../registry';
import { text } from './text';

/** Free text pinned to the pane (does not move with the chart): `coords: 'pane'`,
 * otherwise identical to the Text tool (top-left at the anchor). */
export const pinnedText = defineDrawingTool({
  ...text,
  type: 'pinned-text',
  name: 'Pinned text',
  coords: 'pane',
});
