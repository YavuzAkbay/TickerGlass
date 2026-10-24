import type { AnyIndicatorDefinition } from '../../registry';
import { CHART_PATTERNS } from '../chart-patterns';
import { SWING_FIB } from '../swing-fib';
import { HIGH_LOW_52W } from '../high-low-52w';
import { LINREG_CHANNEL } from '../linreg-channel';
import { SWING_HL } from '../swing-hl';
import { SEASONALITY } from '../seasonality';
import { VP_SESSION } from '../vp-session';
import { VP_VISIBLE } from '../vp-visible';
import { ZIGZAG } from '../zigzag';

export {
  CHART_PATTERNS,
  SWING_FIB,
  HIGH_LOW_52W,
  LINREG_CHANNEL,
  SWING_HL,
  SEASONALITY,
  VP_SESSION,
  VP_VISIBLE,
  ZIGZAG,
};

/**
 * Structural / other built-ins: pivots, ZigZag, regression channel, profiles (Phase 12, batch B6), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 * Pivot Points (all types) is a core built-in (builtins/index.ts).
 */
export const OTHER: readonly AnyIndicatorDefinition[] = [
  // other
  SWING_HL,
  ZIGZAG,
  SWING_FIB,
  CHART_PATTERNS,
  LINREG_CHANNEL,
  HIGH_LOW_52W,
  SEASONALITY,
  // volume
  VP_VISIBLE,
  VP_SESSION,
];
