import { makePitchfork } from './pitchfork';

/** Modified Schiff pitchfork: origin at the midpoint of anchors 1-2 (time and price). */
export const modifiedSchiffPitchfork = makePitchfork(
  'modified-schiff-pitchfork',
  'Modified Schiff pitchfork',
  'modified-schiff',
);
