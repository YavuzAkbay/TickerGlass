import type { AnyIndicatorDefinition } from '../../registry';
import { ALLIGATOR } from '../alligator';
import { ALMA } from '../alma';
import { DEMA } from '../dema';
import { ENVELOPES } from '../envelopes';
import { FRACTALS } from '../fractals';
import { KAMA } from '../kama';
import { LSMA } from '../lsma';
import { MA_RIBBON } from '../ma-ribbon';
import { MCGINLEY } from '../mcginley';
import { MEDIAN_PRICE } from '../median-price';
import { SMMA } from '../smma';
import { TEMA } from '../tema';
import { TYPICAL_PRICE } from '../typical-price';

export {
  ALLIGATOR,
  ALMA,
  DEMA,
  ENVELOPES,
  FRACTALS,
  KAMA,
  LSMA,
  MA_RIBBON,
  MCGINLEY,
  MEDIAN_PRICE,
  SMMA,
  TEMA,
  TYPICAL_PRICE,
};

/**
 * Trend and moving-average built-ins (Phase 12, batch B2), in Indicators-dialog order within a category (the category of each
 * definition decides where it is listed). One file per indicator in
 * `src/builtins/`; import it here, add it to this array and export it.
 */
export const TREND_MA: readonly AnyIndicatorDefinition[] = [
  // moving averages
  SMMA,
  DEMA,
  TEMA,
  ALMA,
  KAMA,
  LSMA,
  MCGINLEY,
  MA_RIBBON,
  // bands
  ENVELOPES,
  // trend
  ALLIGATOR,
  FRACTALS,
  // other
  MEDIAN_PRICE,
  TYPICAL_PRICE,
];
