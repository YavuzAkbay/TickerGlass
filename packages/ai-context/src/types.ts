/** Columnar bars (the engine's `SeriesStore` shape): times in unix seconds, oldest first. */
export interface BriefBars {
  readonly length: number;
  readonly time: ArrayLike<number>;
  readonly open: ArrayLike<number>;
  readonly high: ArrayLike<number>;
  readonly low: ArrayLike<number>;
  readonly close: ArrayLike<number>;
  readonly volume: ArrayLike<number>;
}

/** One indicator on the chart; every output is aligned to `BriefInput.bars` (NaN = no value). */
export interface BriefStudy {
  /** As the legend shows it, e.g. `RSI 14`. */
  readonly title: string;
  readonly outputs: readonly { readonly name: string; readonly values: ArrayLike<number> }[];
}

export interface BriefDrawing {
  /** Tool id, e.g. `trend-line`, `horizontal-line`, `rectangle`. */
  readonly type: string;
  readonly points: readonly { readonly time: number; readonly price: number }[];
  readonly text?: string;
}

/** What the brief concentrates on: a user selection or the visible range. Inclusive times. */
export interface BriefFocus {
  readonly kind: 'selection' | 'visible';
  readonly from: number;
  readonly to: number;
}

export interface BriefInput {
  readonly symbol: string;
  readonly name?: string;
  readonly interval: string;
  /** IANA zone the times are written in (the chart's timezone). */
  readonly timezone: string;
  /** Decimals for prices; inferred from the data when absent. */
  readonly pricePrecision?: number;
  readonly bars: BriefBars;
  readonly studies?: readonly BriefStudy[];
  readonly drawings?: readonly BriefDrawing[];
  readonly focus: BriefFocus;
  /** Extra header lines, e.g. that the bars are Heikin Ashi rather than real prices. */
  readonly notes?: readonly string[];
}

export interface BriefOptions {
  /** Token budget for the whole brief (approximate). Default 4000. */
  readonly maxTokens?: number;
  /** Most rows for the focus bars before they are aggregated. Default 250. */
  readonly maxFocusRows?: number;
  /** Bars before the focus summarised as background. Default 100. */
  readonly leadBars?: number;
  /** Rows the lead-in is aggregated into. Default 25. */
  readonly leadRows?: number;
}

export interface PricePoint {
  readonly time: number;
  readonly price: number;
}

export interface FocusStats {
  readonly bars: number;
  readonly from: number;
  readonly to: number;
  readonly open: number;
  readonly close: number;
  readonly change: number;
  readonly changePct: number;
  readonly high: PricePoint;
  readonly low: PricePoint;
  readonly upBars: number;
  readonly downBars: number;
  /** Biggest close-to-close moves inside the focus, in %. */
  readonly largestUp: PricePoint | null;
  readonly largestDown: PricePoint | null;
  readonly largestUpPct: number | null;
  readonly largestDownPct: number | null;
  /** Standard deviation of close-to-close returns, in %. */
  readonly volatilityPct: number | null;
  readonly atr: number | null;
  /** Least-squares slope of the closes per bar, and its R². */
  readonly slope: number | null;
  readonly r2: number | null;
  readonly avgVolume: number | null;
  /** Average volume of the focus divided by that of the same number of bars before it. */
  readonly volumeVsPrior: number | null;
  readonly maxVolume: PricePoint | null;
  readonly swingHighs: readonly PricePoint[];
  readonly swingLows: readonly PricePoint[];
  /** Change over the bars just before the focus (as many as it has, 5 to 50), in %. */
  readonly priorChangePct: number | null;
  /** Change from the focus end to the last bar on the chart, in %, and bars after the focus. */
  readonly afterChangePct: number | null;
  readonly barsAfter: number;
}

export interface ChartBrief {
  /** The block to send to the model, between `CHART CONTEXT` and `END CHART CONTEXT`. */
  readonly text: string;
  /** `null` when the focus holds no bars. */
  readonly stats: FocusStats | null;
  readonly approxTokens: number;
  /** Bars in the focus and how many were aggregated into one row (1 = full detail). */
  readonly focusBars: number;
  readonly focusBucket: number;
  /** Which reductions were needed to fit `maxTokens`. */
  readonly trimmed: readonly string[];
}
