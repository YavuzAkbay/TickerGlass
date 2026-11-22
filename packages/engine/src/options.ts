export interface ChartTheme {
  background: string;
  text: string;
  textMuted: string;
  grid: string;
  border: string;
  crosshair: string;
  crosshairLabelBg: string;
  crosshairLabelText: string;
  up: string;
  down: string;
  wickUp: string;
  wickDown: string;
  extendedHoursBg: string;
  prevClose: string;
  fontFamily: string;
  fontSize: number;
}

const CHROME_FONT =
  "'Instrument Sans Variable', 'Instrument Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

export const DARK_THEME: ChartTheme = {
  background: '#0F1214',
  text: '#C9D0D6',
  textMuted: '#8A949C',
  grid: 'rgba(230, 234, 237, 0.045)',
  border: '#262C32',
  // Neutral crosshair with paper-coloured axis labels: the chart's colour is price direction.
  crosshair: '#8A949C99',
  crosshairLabelBg: '#E6EAED',
  crosshairLabelText: '#0F1214',
  up: '#34C38F',
  down: '#F2626B',
  wickUp: '#34C38F',
  wickDown: '#F2626B',
  extendedHoursBg: '#9AA8FF0D',
  prevClose: '#8A949C',
  fontFamily: CHROME_FONT,
  fontSize: 11,
};

export const LIGHT_THEME: ChartTheme = {
  ...DARK_THEME,
  background: '#F4F6F8',
  text: '#15191D',
  textMuted: '#5F6B75',
  grid: 'rgba(21, 25, 29, 0.05)',
  border: '#E1E6EA',
  crosshair: '#5F6B75A6',
  crosshairLabelBg: '#15191D',
  crosshairLabelText: '#FFFFFF',
  up: '#138A5E',
  down: '#D23F4A',
  wickUp: '#138A5E',
  wickDown: '#D23F4A',
  extendedHoursBg: '#4C5BD40D',
  prevClose: '#5F6B75',
};

export type CrosshairMode = 'cross' | 'dot' | 'arrow';
export type MagnetMode = 'off' | 'weak' | 'strong';

/** Main-pane legend title: the symbol, its description, or both. */
export type LegendTitleMode = 'ticker' | 'description' | 'both';

/** What the main-pane legend (status line) shows. */
export interface LegendOptions {
  title: LegendTitleMode;
  /** Exchange name after the interval. */
  exchange: boolean;
  /** Open, high, low and close values. */
  ohlc: boolean;
  /** Change from the previous close, absolute and percent. */
  barChange: boolean;
  volume: boolean;
  /** Backdrop behind the legend text. */
  background: boolean;
}

export const DEFAULT_LEGEND_OPTIONS: LegendOptions = {
  title: 'ticker',
  exchange: true,
  ohlc: true,
  barChange: true,
  volume: true,
  background: false,
};

export interface ChartOptions {
  theme: ChartTheme;
  /** 'exchange' uses the symbol's exchange timezone. */
  timezone: 'exchange' | 'local' | 'UTC' | (string & {});
  crosshair: CrosshairMode;
  magnet: MagnetMode;
  /** Initial bars requested per load / history page. */
  pageSize: number;
  prepost: boolean;
  adjusted: boolean;
  /** Dashed line at the previous session's close (intraday). */
  showPrevClose: boolean;
  locale: string;
  /** "+" box beside the price axis, level with the crosshair label (emits `priceAxisPlus`). */
  priceAxisPlusButton: boolean;
  legend: LegendOptions;
}

export const DEFAULT_OPTIONS: ChartOptions = {
  theme: DARK_THEME,
  timezone: 'exchange',
  crosshair: 'cross',
  magnet: 'off',
  pageSize: 2000,
  prepost: false,
  adjusted: false,
  showPrevClose: false,
  locale: 'en-US',
  priceAxisPlusButton: true,
  legend: DEFAULT_LEGEND_OPTIONS,
};
