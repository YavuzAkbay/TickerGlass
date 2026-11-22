# Simplify the Welcome / Data source dialog

## Context
The welcome dialog (`apps/web/src/setup/DataSourceDialog.tsx`, screenshot provided) renders every provider's full detail inline: 15+ capability chips per card, the complete env-var table (Twelve Data shows ~10 `TWELVEDATA_*` rows), budget text, usage meters, terms warnings, and stacked head tags (`(from MARKET_PROVIDER)`, Online, Plan, In use). The result is a wall of noise where the actual job — confirm data works, pick a provider, start charting — is buried. The user chose progressive disclosure: compact cards by default, technical detail behind a per-card **Details** expander.

## Design

Card (collapsed by default) shows only:
- **Head row**: provider name (left) · action (right, `margin-left: auto`): `Use` button for a configured inactive provider when switching is allowed, or the accent `In use` badge for the active one.
- **One-line description** (`p.description`).
- Unconfigured provider: one slim red inline line — `Needs TWELVEDATA_API_KEY set in .env and an API restart` (required missing vars only, `role="alert"`; replaces the boxed warning).
- **`⌄ Details` toggle** (button + `useState` + rotating `ChevronDown`, the pattern used in `SymbolCard.tsx`/`LegendGroup.tsx`).

Details (expanded) contains, in order:
- Meta line: Online/Offline · Plan · how it was chosen (`selectedByText`)
- Terms warning (Yahoo), muted styling
- `CapabilityChips` (unchanged component)
- `ConfigLine` env list (unchanged)
- Active card only: `LimitsSummary` + `UsageBar`
- Non-active card when switching is locked (`onUse` undefined): the `EnvSwitch` line stays **outside** Details since it's then the only way to switch; otherwise (locked + active) it's irrelevant.

Other simplifications:
- Lead copy shortened: first run → "Pick where market data comes from. You can change it any time in Settings → Data source." ; later runs → "The market data provider this instance runs on."
- Test status ok line compacted to `Connected · SPY 767.89 · 1297 ms`.
- Header tags Online/Plan/selectedBy move into Details; drop the `(from MARKET_PROVIDER)` from the head.

## Files
1. **`apps/web/src/setup/DataSourceDialog.tsx`** — restructure `ProviderCard`: compact head, inline missing-var note, Details disclosure (local `useState`, collapsed). Split the disclosure content into an exported `ProviderDetails` component so tests can render it statically. Trim lead copy; tweak `TestStatus` ok text.
2. **`apps/web/src/setup/setup.css`** — compact card styles: head with right-aligned action, small `ds-details-toggle`, `ds-details` stack, borderless red note, meta line; keep `.ds-chip`/`.ds-config`/`.ds-meter` styles (still used inside Details). Shared classes keep the Settings picker visually consistent automatically.
3. **`apps/web/src/setup/DataSourceDialog.test.tsx`** — update: collapsed card asserts name/desc/Use/In-use and that chips+env are absent; `ProviderDetails` rendered directly asserts chips (incl. `aria-label="Live stream: not available"`), config badges, secret-value safety, limits, usage bars, selectedBy note. Keep `TestStatus` tests (copy updated).
4. **`apps/web/src/setup/ProviderPicker.tsx`** — no structural change (Settings tab is already lean; its tests must keep passing). Only adopt the shared compact classes if markup needs it; leave `EnvSwitch`, `UseButton`, `useChooseProvider`, `lockedText`, `selectedByText` exports untouched — the dialog reuses them.

Reused as-is: `Modal` (`apps/web/src/ui/Modal.tsx`), `capabilityChips`/`CapabilityChips`, `ConfigLine`, `LimitsSummary`, `UsageBar`, `Meter`, `TestStatus` internals, all `ProviderPicker` helpers.

## Verification
- `pnpm test` (vitest) for `setup/` — `DataSourceDialog.test.tsx` + `ProviderPicker.test.tsx` green; typecheck/lint per repo scripts.
- Run the dev server, open the dialog (first-run and Settings → Data source) in the browser: collapsed cards by default, Details expands/collapses, Use switch works, not-configured state shows the one-line note; screenshot to confirm the uncluttered layout.