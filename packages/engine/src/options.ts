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
  background: '#14130F',
  text: '#CFC9BA',
  textMuted: '#9A9484',
  grid: 'rgba(236, 231, 218, 0.05)',
  border: '#34312A',
  // Amber crosshair and axis labels: the app accent, not a neutral grey.
  crosshair: '#E0A93B99',
  crosshairLabelBg: '#E0A93B',
  crosshairLabelText: '#14130F',
  up: '#7FB069',
  down: '#DE6A4F',
  wickUp: '#7FB069',
  wickDown: '#DE6A4F',
  extendedHoursBg: '#E0A93B0F',
  prevClose: '#A39E8F',
  fontFamily: CHROME_FONT,
  fontSize: 11,
};

export const LIGHT_THEME: ChartTheme = {
  ...DARK_THEME,
  background: '#F6F3EC',
  text: '#1E1B16',
  textMuted: '#6F6859',
  grid: 'rgba(30, 27, 22, 0.06)',
  border: '#DDD6C7',
  crosshair: '#8A5D0EA6',
  crosshairLabelBg: '#8A5D0E',
  crosshairLabelText: '#FFFFFF',
  up: '#2F7D5B',
  down: '#B5452F',
  wickUp: '#2F7D5B',
  wickDown: '#B5452F',
  extendedHoursBg: '#8A5D0E0D',
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
