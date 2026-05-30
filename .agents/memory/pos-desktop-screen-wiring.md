---
name: POS Desktop new-screen wiring (PosShell)
description: Adding a new admin screen to POS Desktop requires FOUR separate edits in PosShell/permissions or it silently breaks.
---

Adding a new standalone admin screen to POS Desktop (`artifacts/pos-desktop`) is not done until ALL of these are present — missing any one fails silently (no type error, nothing renders):

1. `permissions.ts` — add the key to the `ScreenKey` union AND to a `SCREEN_KEYS` group (otherwise the permission checkbox / `can()` gate can't reference it).
2. `PosShell.tsx` — add the key to the local `View` type.
3. `PosShell.tsx` — add a nav entry (NAV_GROUPS member + standaloneNav entry) and the component import.
4. `PosShell.tsx` — add the **render branch** in the main content switch, gated like siblings:
   `{standalone && view === "<key>" && (isAdmin || can("<key>")) && (<div style={S.pagePad}><XAdmin /></div>)}`
   This is the step that is easy to forget — typecheck passes without it because the import is "used" by being imported, and the View/nav/permission wiring all typecheck fine. The screen is simply unreachable.

Also: `labelFor(v: View)` is an exhaustive record keyed by `View`; adding a `View` member without a matching label entry IS a type error (`string | undefined`), so that one is caught — but the render branch is not.

**Why:** the Taxes (الضرائب) screen shipped with View+nav+permission+import all wired and typecheck green, yet clicking it showed nothing because the content-switch render branch was missing. Caught only by architect review, not by tsc.
