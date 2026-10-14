import { defineDrawingTool } from '../registry';
import {
  defaultPitchforkLevels,
  hitPitchfan,
  PITCHFORK_COMMON_DEFAULTS,
  PITCHFORK_COMMON_PROPERTIES,
  pitchfanInView,
  renderPitchfan,
  type PitchforkCommonStyle,
} from './pitchfork-common';

export const PITCHFAN_DEFAULTS: PitchforkCommonStyle = {
  ...PITCHFORK_COMMON_DEFAULTS,
  levels: defaultPitchforkLevels(),
};

/** Pitchfan: rays from anchor 1 through the midpoint of anchors 2-3 and the level points on 2-3. */
export const pitchfan = defineDrawingTool({
  type: 'pitchfan',
  name: 'Pitchfan',
  group: 'fib',
  creation: { kind: 'points', count: 3 },
  defaults: PITCHFAN_DEFAULTS,
  properties: PITCHFORK_COMMON_PROPERTIES,

  render({ ctx }, g, s) {
    renderPitchfan(ctx, g, s);
  },

  hitTest(g, s, x, y, tol) {
    return hitPitchfan(g, s, x, y, tol);
  },

  isVisible(g, s) {
    return pitchfanInView(g, s);
  },
});
