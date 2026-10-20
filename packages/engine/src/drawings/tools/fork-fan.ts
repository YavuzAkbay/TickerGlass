import { defineDrawingTool } from '../registry';
import {
  defaultPitchforkLevels,
  hitForkFan,
  PITCHFORK_COMMON_DEFAULTS,
  PITCHFORK_COMMON_PROPERTIES,
  forkFanInView,
  renderForkFan,
  type PitchforkCommonStyle,
} from './pitchfork-common';

export const FORK_FAN_DEFAULTS: PitchforkCommonStyle = {
  ...PITCHFORK_COMMON_DEFAULTS,
  levels: defaultPitchforkLevels(),
};

/** Fork fan: rays from anchor 1 through the midpoint of anchors 2-3 and the level points on 2-3. */
export const forkFan = defineDrawingTool({
  type: 'fork-fan',
  name: 'Fork fan',
  group: 'fib',
  creation: { kind: 'points', count: 3 },
  defaults: FORK_FAN_DEFAULTS,
  properties: PITCHFORK_COMMON_PROPERTIES,

  render({ ctx }, g, s) {
    renderForkFan(ctx, g, s);
  },

  hitTest(g, s, x, y, tol) {
    return hitForkFan(g, s, x, y, tol);
  },

  isVisible(g, s) {
    return forkFanInView(g, s);
  },
});
