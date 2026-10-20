import { makePitchfork } from './pitchfork';

/**
 * Inner pitchfork: origin at the midpoint m of anchors 1-2; the handle
 * runs m -> anchor 3 and the median and tines are parallel to it, starting on
 * anchors 2-3.
 */
export const innerPitchfork = makePitchfork('inner-pitchfork', 'Inner pitchfork', 'inside');
