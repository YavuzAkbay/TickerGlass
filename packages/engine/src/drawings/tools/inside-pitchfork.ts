import { makePitchfork } from './pitchfork';

/**
 * Inside pitchfork: origin at the midpoint m of anchors 1-2; the handle
 * runs m -> anchor 3 and the median and tines are parallel to it, starting on
 * anchors 2-3.
 */
export const insidePitchfork = makePitchfork('inside-pitchfork', 'Inside pitchfork', 'inside');
