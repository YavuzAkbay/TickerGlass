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

const CHROME_FONT = "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";

export const DARK_THEME: ChartTheme = {
  background: '#0e1116',
  text: '#c3cad5',
  textMuted: '#8b95a5',
  grid: 'rgba(255, 255, 255, 0.04)',
  border: '#262e39',
  crosshair: '#7f92e8',
  crosshairLabelBg: '#2a3350',
  crosshairLabelText: '#e6eaf0',
  up: '#18a383',
  down: '#e5484d',
  wickUp: '#18a383',
  wickDown: '#e5484d',
  extendedHoursBg: '#4f6bed12',
  prevClose: '#9aa4b2',
  fontFamily: CHROME_FONT,
  fontSize: 11,
};

export const LIGHT_THEME: ChartTheme = {
  ...DARK_THEME,
  background: '#f7f8fa',
  text: '#151a21',
  textMuted: '#5d6878',
  grid: 'rgba(0, 0, 0, 0.05)',
  border: '#dde2e8',
  crosshair: '#5a70d8',
  crosshairLabelBg: '#3f5bdb',
  crosshairLabelText: '#ffffff',
  up: '#18a383',
  down: '#e5484d',
  wickUp: '#18a383',
  wickDown: '#e5484d',
  extendedHoursBg: '#4f6bed0d',
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
  /** "+" box on the price axis crosshair label (emits `priceAxisPlus`). */
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
