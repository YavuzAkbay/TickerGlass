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
import { EXTERNAL } from './groups/external';
import { FINANCIALS } from './groups/financials';
import { MOMENTUM } from './groups/momentum';
import { OTHER } from './groups/other';
import { TREND_MA } from './groups/trend-ma';
import { VOLATILITY } from './groups/volatility';
import { VOLUME_GROUP } from './groups/volume';

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
export { anchorPeriod, VWAP_ANCHORS, VWAP_EVENT_ANCHORS } from './vwap';
export type { VwapAnchor, VwapEventAnchor } from './vwap';
export * from './groups/external';
export * from './groups/financials';
export * from './groups/momentum';
export * from './groups/other';
export * from './groups/trend-ma';
export * from './groups/volatility';
export * from './groups/volume';

/** Built-ins before Phase 12, in Indicators-dialog order within a category. */
const CORE: readonly AnyIndicatorDefinition[] = [
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

/**
 * Every built-in definition, in Indicators-dialog order within a category.
 * Phase 12 groups each own one file in `groups/`; edit those, not this list.
 */
export const BUILTIN_INDICATORS: readonly AnyIndicatorDefinition[] = [
  ...CORE,
  ...TREND_MA,
  ...MOMENTUM,
  ...VOLUME_GROUP,
  ...VOLATILITY,
  ...OTHER,
  ...EXTERNAL,
  ...FINANCIALS,
];

for (const def of BUILTIN_INDICATORS) defaultRegistry.register(def);
