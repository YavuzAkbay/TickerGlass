## Context

The right-edge drawing dock (`ToolRail`) currently shows five categories: **Lines, Shapes, Text, Measure, Patterns**. Two problems:

1. **Fib retracement — one of the most-used trader tools — is buried near the bottom of the 29-tool "Measure" flyout** (which mixes navigation, trade planning, volume profiles, rulers, Fib and Gann).
2. **Shapes get prime slot #2** although they're rarely used by traders.

Redesign: give Fib & Gann its own top category (first below the cursor), demote Shapes into a combined "Markup" category, and make every category button a **one-click split button** (click = arm that category's last-used/default tool, corner arrow = full flyout) — reusing the existing `SplitButton` pattern already used by the cursor button.

## Changes

### 1. `apps/web/src/toolbar/dock.ts` — new category layout (still 5 buttons, rail size unchanged)

`DOCK_CATEGORIES` becomes (top → bottom):

| # | Category | Content | Groups |
|---|----------|---------|--------|
| 1 | **Fib & Gann** (new, icon `IconFibRetracement`) | Fibonacci (retracement first), Gann | `['fib']` |
| 2 | **Lines** (unchanged) | Levels, Trends, Channels, Pitchforks | `['lines']` |
| 3 | **Measure** (fib removed) | Navigate (measure/zoom), Trade planning, Volume, Rulers | `['forecasting', 'measure', 'zoom']` |
| 4 | **Patterns** (unchanged) | Price patterns, Elliott waves, Cycles | `['patterns']` |
| 5 | **Markup** (renamed from "Text", absorbs Shapes) | Notes & labels, then Pen, Markers, Shapes (last) + sticker grid | `['annotation', ICONS_GROUP_ID, 'shapes']`, `stickers: true` |

Nothing is deleted — every tool stays reachable, shapes just move to the bottom of Markup.

Add one helper (pure, no store access):

```ts
/** First available tool of a category — what its rail button arms by default. */
export function defaultToolOf(cat: DockCategory): ToolDef | undefined
```

Default armed tools fall out naturally as each category's first available tool: fib-retracement (Alt+F), trend-line (Alt+T), measure, head-shoulders, text. Update the file's header comment.

No changes needed in `tools.ts` (catalog `TOOL_GROUPS` stays as-is — group ids drive last-used memory, shortcuts and persistence, so nothing to migrate) nor in `commands.ts` / quick tools (Alt+D) / favorites bar.

### 2. `apps/web/src/toolbar/ToolRail.tsx` — one-click split category buttons

Rewrite `CategoryButton` to reuse the existing `SplitButton` component (same file, lines ~56-112, already used by `CursorButton`):

- **Icon/tooltip**: the armed tool — active tool while drawing, else the category's last-used tool (first entry in `ui.groupTools` across `cat.groups` that still maps to this category via `categoryOf`), else `defaultToolOf(cat)`. Tooltip = armed tool's name + its shortcut (fib retracement thus shows Alt+F).
- **Click**: `selectTool(armed.id)` — one click arms fib retracement, trend line, etc.
- **Corner arrow (hover)**: opens the existing `CategoryFlyout` (searchable, sections, star-to-favorite) — unchanged; right-click also opens it, matching `SplitButton`.
- Active/highlight behavior (`categoryOf(activeTool)?.id === cat.id`) preserved.

### 3. `apps/web/src/toolbar/dock.test.ts` — update assertions

- Expected labels: `['Fib & Gann', 'Lines', 'Measure', 'Patterns', 'Markup']`.
- `categoryOf('fib-retracement')?.id` → `'fib'`; add `categoryOf('rectangle')?.id === 'markup'`.
- Search test must look up Lines by id instead of `DOCK_CATEGORIES[0]` (which is now Fib & Gann).
- Coverage check ("every catalog tool except cursors is docked") must still pass unchanged.

## Verification

- `vitest run src/toolbar` in `apps/web` (dock tests) plus full unit test suite to catch any category-order dependencies.
- Typecheck/build of `apps/web`.
- Manual check in dev server: fib button click arms retracement; hover arrow opens Fib & Gann flyout; Measure flyout no longer contains Fib/Gann; Markup lists Notes before Shapes; Alt+D quick tools and favorites bar unaffected; persisted `groupTools` state still applies.
- E2E `drawing-sweep.spec.ts` needs no changes (it drives the engine API, not the rail).