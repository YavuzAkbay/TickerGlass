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
  'topbar.compare': 'Overlay a symbol',
  'topbar.indicators': 'Indicators',
  'topbar.alert': 'Create alert',
  'topbar.replay': 'Playback',
  'topbar.settings': 'Settings',
  'topbar.shortcuts': 'Keyboard shortcuts',
  'topbar.dataSource': 'Data source…',
  'topbar.symbolSearch': 'Symbol search',
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
  'topbar.downloadDataCsv': 'Download data (CSV)',
  'topbar.downloadDataXlsx': 'Download data (XLSX)',
  'topbar.themeLight': 'Switch to light theme',
  'topbar.themeDark': 'Switch to dark theme',
  'topbar.palette': 'Type a command, ticker or indicator…',
  'topbar.paletteLabel': 'Open command palette',
  'topbar.more': 'More',
  'topbar.snapshotMenu': 'Snapshot',

  // Symbol card (on each chart)
  'symbolHeader.label': 'Symbol summary',
  'symbolHeader.search': 'Symbol search, current symbol {symbol}',
  'symbolHeader.openDetails': 'Open details for {symbol}',
  'symbolHeader.range': 'Day range',
  'symbolHeader.volume': 'Volume',
  'symbolHeader.earnings': 'Next earnings',

  // Navigator
  'inspector.label': 'Inspector',
  'inspector.symbol': 'Symbol details',
  'inspector.drawing': 'Drawing',
  'inspector.indicator': 'Indicator',
  'inspector.close': 'Close inspector',
  'inspector.resize': 'Resize inspector (double-click to reset)',
  'drawing.settings': 'Settings',
  'nav.panels': 'Panels',
  'nav.watchlist': 'Watchlist',
  'nav.alerts': 'Alerts',
  'nav.timeline': 'Timeline',
  'nav.notes': 'Notes',
  'nav.objectTree': 'Layers',
  'nav.dataWindow': 'Values',
  'nav.replayTrading': 'Practice trades',
  'nav.unread': '{count} unread',
  'nav.resize': 'Resize navigator (double-click to reset)',
  'nav.addSymbol': 'Add symbol',
  'nav.collapse': 'Collapse panel',
  'nav.expand': 'Expand panel',
  'nav.loading': 'Loading',
  'nav.retry': 'Retry',
  'timeline.scope': 'Timeline scope',
  'timeline.upcoming': 'Upcoming',
  'timeline.recent': 'Recent',
  'timeline.empty': 'Nothing in the last year: no alerts fired, no news or events.',
  'timeline.emptyList': 'Add symbols to your watchlist to follow them here.',
  'timeline.newsError': 'News unavailable: {error}',
  'timeline.newsUnsupported': 'News: not available from {provider}',
  'timeline.watchlistNote': 'Earnings, dividends and splits show for the chart symbol.',

  // Data provider budget (top bar chip)
  'budget.exhausted': '{provider} credits exhausted: showing cached data until {time}',
  'budget.throttled': '{provider} request limit reached: data refreshes slowly until {time}',

  // Tool rail
  // Desks
  'desk.title': 'Desks',
  'desk.none': 'No desks yet',
  'desk.current': 'Desk: {name}',
  'desk.saveAs': 'Save current as desk…',
  'desk.update': 'Update "{name}" from current',
  'desk.rename': 'Rename desk…',
  'desk.delete': 'Delete desk',
  'rail.drawingTools': 'Drawing tools',
  'rail.options': 'Drawing options',
  'rail.syncNew': 'Show new drawings on every symbol',
  'rail.quickTools': 'Quick drawing tools',
  'rail.stayDrawing': 'Keep the tool after drawing',
  'rail.lockAll': 'Lock all drawings',
  'rail.showFavorites': 'Favorites toolbar',
  'rail.removeDrawings': 'Remove drawings',
  'rail.removeIndicators': 'Remove indicators',
  'rail.removeAll': 'Clear the chart',

  // Chart
  'chart.label': 'Chart: {symbol}, {interval}',
  'chart.live': 'Bar {time}: open {open}, high {high}, low {low}, close {close}',

  // Settings dialog
  'settings.tab.symbol': 'Series',
  'settings.tab.status': 'Legend',
  'settings.tab.scales': 'Axes',
  'settings.tab.canvas': 'Background',
  'settings.tab.trading': 'Practice',
  'settings.tab.alerts': 'Alerts',
  'settings.tab.events': 'Markers',
  'settings.tab.dataSource': 'Data source',
  'settings.dataSource.title': 'Market data provider',
  'settings.dataSource.note':
    'Applies immediately, not with Ok or Cancel: the page reloads on the new provider and cached market data is cleared. Other changes in this dialog that are not applied with Ok are discarded.',
} satisfies Record<string, string>;

export type MessageKey = keyof typeof en;
/** A complete catalog: every key of `en` translated. */
export type Catalog = Record<MessageKey, string>;
