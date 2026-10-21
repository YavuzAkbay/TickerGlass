/**
 * English message catalog (the source locale and the fallback). The keys of
 * this object are the `MessageKey` type: a key used in code but missing here
 * is a compile error, and every other locale is checked against it.
 * Placeholders are written `{name}`.
 */
export const en = {
  // Shell
  'modal.close': 'Close',

  // Command bar
  'topbar.toolbar': 'Chart toolbar',
  'topbar.compare': 'Compare or add symbol',
  'topbar.indicators': 'Indicators',
  'topbar.alert': 'Create alert',
  'topbar.alertShort': 'Alert',
  'topbar.replay': 'Bar replay',
  'topbar.replayShort': 'Replay',
  'topbar.settings': 'Settings',
  'topbar.shortcuts': 'Keyboard shortcuts',
  'topbar.symbolSearch': 'Symbol search',
  'topbar.symbolSearchCurrent': 'Symbol search, current symbol {symbol}',
  'topbar.chartType': 'Chart type: {type}',
  'topbar.showTools': 'Show drawing tools',
  'topbar.hideTools': 'Hide drawing tools',
  'topbar.undo': 'Undo',
  'topbar.undoItem': 'Undo {label}',
  'topbar.redo': 'Redo',
  'topbar.redoItem': 'Redo {label}',
  'topbar.fullscreen': 'Fullscreen mode',
  'topbar.exitFullscreen': 'Exit fullscreen',
  'topbar.snapshot': 'Take a snapshot',
  'topbar.snapshotOptions': 'Snapshot options',
  'topbar.downloadImage': 'Download image',
  'topbar.copyImage': 'Copy image',
  'topbar.themeLight': 'Switch to light theme',
  'topbar.themeDark': 'Switch to dark theme',

  // Navigator
  'nav.panels': 'Panels',
  'nav.watchlist': 'Watchlist',
  'nav.alerts': 'Alerts',
  'nav.events': 'Events',
  'nav.news': 'News',
  'nav.notes': 'Notes',
  'nav.objectTree': 'Object tree',
  'nav.dataWindow': 'Data window',
  'nav.replayTrading': 'Replay trading',
  'nav.unread': '{count} unread',
  'nav.resize': 'Resize navigator (double-click to reset)',
  'nav.addSymbol': 'Add symbol',
  'nav.collapse': 'Collapse panel',
  'nav.expand': 'Expand panel',
  'nav.loading': 'Loading',
  'nav.retry': 'Retry',
  'nav.events.none': 'No events for this symbol',
  'nav.events.earnings': 'Earnings',
  'nav.events.dividend': 'Dividend',
  'nav.events.split': 'Split',

  // Tool rail
  'rail.drawingTools': 'Drawing tools',
  'rail.weakMagnet': 'Weak magnet',
  'rail.strongMagnet': 'Strong magnet',
  'rail.magnetModes': 'Magnet modes',
  'rail.stayDrawing': 'Stay in drawing mode',
  'rail.syncAll': 'New drawings: synced to all symbols',
  'rail.syncOne': 'New drawings: this symbol only',
  'rail.unlockAll': 'Unlock all drawings',
  'rail.lockAll': 'Lock all drawings',
  'rail.hideFavorites': 'Hide favorites toolbar',
  'rail.showFavorites': 'Show favorites toolbar',
  'rail.removeDrawings': 'Remove drawings',
  'rail.removeIndicators': 'Remove indicators',
  'rail.removeAll': 'Remove drawings & indicators',
  'rail.removeOptions': 'Remove options',

  // Chart
  'chart.label': 'Chart: {symbol}, {interval}',
  'chart.live': 'Bar {time}: open {open}, high {high}, low {low}, close {close}',

  // Settings dialog
  'settings.tab.symbol': 'Symbol',
  'settings.tab.status': 'Status line',
  'settings.tab.scales': 'Scales and lines',
  'settings.tab.canvas': 'Canvas',
  'settings.tab.trading': 'Trading',
  'settings.tab.alerts': 'Alerts',
  'settings.tab.events': 'Events',
} satisfies Record<string, string>;

export type MessageKey = keyof typeof en;
/** A complete catalog: every key of `en` translated. */
export type Catalog = Record<MessageKey, string>;
