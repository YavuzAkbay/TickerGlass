import { defaultRegistry, type AnyIndicatorDefinition } from '../registry';
import { ANCHORED_VWAP } from './anchored-vwap';
import { ATR } from './atr';
import { BOLLINGER } from './bollinger';
import { CCI } from './cci';
import { DMI } from './dmi';
import { DONCHIAN } from './donchian';
import { EMA } from './ema';
import { HMA } from './hma';
import { ICHIMOKU } from './ichimoku';
import { KELTNER } from './keltner';
import { MACD } from './macd';
import { MFI } from './mfi';
import { OBV } from './obv';
import { PARABOLIC_SAR } from './parabolic-sar';
import { PIVOT_POINTS } from './pivot-points';
import { RSI } from './rsi';
import { SMA } from './sma';
import { STOCH_RSI } from './stoch-rsi';
import { STOCHASTIC } from './stochastic';
import { SUPERTREND } from './supertrend';
import { VOLUME } from './volume';
import { VWAP } from './vwap';
import { VWMA } from './vwma';
import { WILLIAMS_R } from './williams-r';
import { WMA } from './wma';

export {
  ANCHORED_VWAP,
  ATR,
  BOLLINGER,
  CCI,
  DMI,
  DONCHIAN,
  EMA,
  HMA,
  ICHIMOKU,
  KELTNER,
  MACD,
  MFI,
  OBV,
  PARABOLIC_SAR,
  PIVOT_POINTS,
  RSI,
  SMA,
  STOCH_RSI,
  STOCHASTIC,
  SUPERTREND,
  VOLUME,
  VWAP,
  VWMA,
  WILLIAMS_R,
  WMA,
};
export { MA_TYPES } from './common';
export type { MaType } from './common';
export { anchorPeriod, VWAP_ANCHORS } from './vwap';
export type { VwapAnchor } from './vwap';

/** Every built-in definition, in Indicators-dialog order within a category. */
export const BUILTIN_INDICATORS: readonly AnyIndicatorDefinition[] = [
  // moving averages
  SMA,
  EMA,
  WMA,
  VWMA,
  HMA,
  // bands
  BOLLINGER,
  KELTNER,
  DONCHIAN,
  // trend
  ICHIMOKU,
  PARABOLIC_SAR,
  SUPERTREND,
  DMI,
  // momentum
  RSI,
  MACD,
  STOCHASTIC,
  STOCH_RSI,
  CCI,
  WILLIAMS_R,
  // volatility
  ATR,
  // volume
  VOLUME,
  VWAP,
  ANCHORED_VWAP,
  OBV,
  MFI,
  // other
  PIVOT_POINTS,
];

for (const def of BUILTIN_INDICATORS) defaultRegistry.register(def);
