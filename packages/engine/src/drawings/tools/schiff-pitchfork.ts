import { makePitchfork } from './pitchfork';

/** Schiff pitchfork: origin halfway in price from anchor 1 to anchor 2 (at anchor 1's time). */
export const schiffPitchfork = makePitchfork('schiff-pitchfork', 'Schiff pitchfork', 'schiff');
