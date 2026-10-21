import { defineDrawingTool } from '../registry';
import {
  defaultPitchforkLevels,
  hitPitchfork,
  PITCHFORK_COMMON_DEFAULTS,
  PITCHFORK_COMMON_PROPERTIES,
  pitchforkInView,
  renderPitchfork,
  type PitchforkCommonStyle,
  type PitchforkVariant,
} from './pitchfork-common';

export type PitchforkStyle = PitchforkCommonStyle & { extendLines: boolean };

/** Fresh pitchfork defaults (own levels array). */
export function pitchforkDefaults(): PitchforkStyle {
  return { ...PITCHFORK_COMMON_DEFAULTS, levels: defaultPitchforkLevels(), extendLines: false };
}

/** A pitchfork tool of one variant (3 anchors: handle origin, then the two swing points). */
export function makePitchfork(type: string, name: string, variant: PitchforkVariant) {
  return defineDrawingTool({
    type,
    name,
    group: 'lines',
    creation: { kind: 'points', count: 3 },
    defaults: pitchforkDefaults(),
    properties: [
      ...PITCHFORK_COMMON_PROPERTIES,
      { kind: 'bool', key: 'extendLines', label: 'Extend lines' },
    ],

    render({ ctx }, g, s) {
      renderPitchfork(ctx, g, s, variant, s.extendLines);
    },

    hitTest(g, s, x, y, tol) {
      return hitPitchfork(g, s, variant, s.extendLines, x, y, tol);
    },

    isVisible(g, s) {
      return pitchforkInView(g, s, variant, s.extendLines);
    },
  });
}

/** Andrews pitchfork: median from anchor 1 through the midpoint of anchors 2-3. */
export const pitchfork = makePitchfork('pitchfork', 'Pitchfork', 'original');
