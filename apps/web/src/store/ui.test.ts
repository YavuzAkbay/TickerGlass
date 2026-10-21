import { beforeEach, describe, expect, it } from 'vitest';
import { migrateNavigator, NAV_SECTIONS, partializeUi, UI_STORE_VERSION, useUiStore } from './ui';
import { SETTING_DEFS } from '../persist/settingsSync';

const uiPrefs = SETTING_DEFS.find((d) => d.key === 'ui.prefs')!;

describe('migrateNavigator', () => {
  it('v2: closed dock with a remembered tab keeps the tab and stays closed', () => {
    const out = migrateNavigator({ rightPanel: null, dockTab: 'notes', dockHeight: 300 });
    expect(out).toEqual({ navOpen: false, navSection: 'notes', navWidth: 260 });
  });

  it('v2: open panel opens the navigator on that section', () => {
    const out = migrateNavigator({ rightPanel: 'alerts', dockTab: 'alerts', dockHeight: 260 });
    expect(out).toEqual({ navOpen: true, navSection: 'alerts', navWidth: 260 });
  });

  it('maps the removed details panel to the watchlist', () => {
    expect(migrateNavigator({ rightPanel: 'details' })).toMatchObject({
      navOpen: true,
      navSection: 'watchlist',
    });
    expect(migrateNavigator({ rightPanel: null, dockTab: 'details' })).toMatchObject({
      navOpen: false,
      navSection: 'watchlist',
    });
  });

  it('never persists the replay trading section', () => {
    expect(migrateNavigator({ rightPanel: 'replayTrading' })).toMatchObject({
      navOpen: true,
      navSection: 'watchlist',
    });
  });

  it('v1: drops rightWidth and opens by the old panel', () => {
    const out = migrateNavigator({ rightPanel: 'news', rightWidth: 300, activeTool: 'cross' });
    expect(out).toEqual({
      navOpen: true,
      navSection: 'news',
      navWidth: 260,
      activeTool: 'cross',
    });
  });

  it('defaults to an open watchlist when no panel keys exist', () => {
    expect(migrateNavigator({})).toEqual({ navOpen: true, navSection: 'watchlist', navWidth: 260 });
  });

  it('ignores unknown section names', () => {
    expect(migrateNavigator({ rightPanel: 'bogus' })).toMatchObject({ navSection: 'watchlist' });
  });

  it('is idempotent and leaves migrated state alone', () => {
    const migrated = { navOpen: false, navSection: 'events', navWidth: 300, inspectorWidth: 320 };
    expect(migrateNavigator(migrated)).toEqual(migrated);
    const once = migrateNavigator({ rightPanel: null, dockTab: 'notes' });
    expect(migrateNavigator(once)).toEqual(once);
  });
});

describe('ui store navigator', () => {
  beforeEach(() => {
    useUiStore.setState({
      navOpen: true,
      navSection: 'watchlist',
      navWidth: 260,
      inspectorWidth: 300,
      inspector: null,
    });
  });

  it('is at version 3', () => {
    expect(UI_STORE_VERSION).toBe(3);
    expect(NAV_SECTIONS[0]).toBe('watchlist');
  });

  it('toggleNav opens a section, switches, and collapses the open one', () => {
    const s = () => useUiStore.getState();
    s().toggleNav('alerts');
    expect([s().navOpen, s().navSection]).toEqual([true, 'alerts']);
    s().toggleNav('alerts');
    expect(s().navOpen).toBe(false);
    expect(s().navSection).toBe('alerts');
    s().toggleNav('notes');
    expect([s().navOpen, s().navSection]).toEqual([true, 'notes']);
  });

  it('showNav opens the section', () => {
    useUiStore.setState({ navOpen: false });
    useUiStore.getState().showNav('alerts');
    expect(useUiStore.getState()).toMatchObject({ navOpen: true, navSection: 'alerts' });
  });

  it('clamps widths', () => {
    useUiStore.getState().setNavWidth(50);
    expect(useUiStore.getState().navWidth).toBe(200);
    useUiStore.getState().setNavWidth(9999);
    expect(useUiStore.getState().navWidth).toBe(480);
    useUiStore.getState().setInspectorWidth(10);
    expect(useUiStore.getState().inspectorWidth).toBe(260);
  });

  it('opens and closes the inspector', () => {
    useUiStore.getState().openInspector('drawing', 'd1');
    expect(useUiStore.getState().inspector).toEqual({ view: 'drawing', id: 'd1' });
    useUiStore.getState().closeInspector();
    expect(useUiStore.getState().inspector).toBeNull();
  });

  it('persists the section as watchlist while replayTrading, and omits the inspector', () => {
    useUiStore.setState({ navSection: 'replayTrading', inspector: { view: 'symbol' } });
    const saved = partializeUi(useUiStore.getState()) as Record<string, unknown>;
    expect(saved.navSection).toBe('watchlist');
    expect(saved).not.toHaveProperty('inspector');
    expect(saved).not.toHaveProperty('rightPanel');
  });
});

describe('ui.prefs sync', () => {
  beforeEach(() => {
    useUiStore.setState({ navOpen: true, navSection: 'watchlist', navWidth: 260 });
  });

  it('migrates a legacy server payload with rightPanel', () => {
    uiPrefs.write({ rightPanel: null, dockHeight: 300, toolRailHidden: true });
    const s = useUiStore.getState();
    expect(s.navOpen).toBe(false);
    expect(s.toolRailHidden).toBe(true);
    expect(s).not.toHaveProperty('rightPanel');
  });

  it('applies a legacy open panel and rejects unknown sections', () => {
    uiPrefs.write({ rightPanel: 'notes' });
    expect(useUiStore.getState()).toMatchObject({ navOpen: true, navSection: 'notes' });
    uiPrefs.write({ navSection: 'bogus', navOpen: false, navWidth: 300 });
    expect(useUiStore.getState()).toMatchObject({
      navOpen: false,
      navSection: 'notes',
      navWidth: 300,
    });
  });

  it('applies current-shape payloads and never reads replayTrading', () => {
    uiPrefs.write({ navOpen: true, navSection: 'events', navWidth: 320, inspectorWidth: 280 });
    expect(useUiStore.getState()).toMatchObject({
      navSection: 'events',
      navWidth: 320,
      inspectorWidth: 280,
    });
    useUiStore.setState({ navSection: 'replayTrading' });
    expect((uiPrefs.read() as { navSection: string }).navSection).toBe('watchlist');
  });
});
