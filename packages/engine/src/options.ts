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

export const DARK_THEME: ChartTheme = {
  background: '#0f1115',
  text: '#b2b5be',
  textMuted: '#787b86',
  grid: '#1c2029',
  border: '#2a2e39',
  crosshair: '#9598a1',
  crosshairLabelBg: '#363a45',
  crosshairLabelText: '#d1d4dc',
  up: '#26a69a',
  down: '#ef5350',
  wickUp: '#26a69a',
  wickDown: '#ef5350',
  extendedHoursBg: '#2962ff12',
  prevClose: '#787b86',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif",
  fontSize: 11,
};

export const LIGHT_THEME: ChartTheme = {
  ...DARK_THEME,
  background: '#ffffff',
  text: '#131722',
  textMuted: '#6a6d78',
  grid: '#f0f3fa',
  border: '#e0e3eb',
  crosshair: '#9598a1',
  crosshairLabelBg: '#131722',
  crosshairLabelText: '#ffffff',
  up: '#089981',
  down: '#f23645',
  wickUp: '#089981',
  wickDown: '#f23645',
  extendedHoursBg: '#2962ff0d',
};

export type CrosshairMode = 'cross' | 'dot' | 'arrow';
export type MagnetMode = 'off' | 'weak' | 'strong';

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
};
