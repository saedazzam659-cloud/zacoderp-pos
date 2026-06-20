---
name: POS Desktop standalone items persistence
description: How items add/edit/delete must work in standalone (offline) mode — SQLite-authoritative with an LS meta overlay for the columns SQLite has no home for.
---

# Items must persist in SQLite in standalone mode

In standalone (offline) mode there is NO cloud, so items have to be authoritative
in SQLite. The old `createItem` wrote LS-only rows, which never survived a real
restart and couldn't be edited/deleted by id.

**Rule:** in standalone, `createItem`/`updateItem`/`deleteItem` go straight to
the Rust SQLite commands:
- `insert_local_item` (returns the real rowid — the items form needs it for the
  follow-up `updateItemWeighed`/`updateItemExtended` calls),
- `update_local_item` (a FULL-row core update: code/name/barcode/price/vat/uom —
  merge the patch over the current row first; pharmacy/scale stay owned by the
  `_extended`/`_weighed` commands),
- `delete_local_item` (hard DELETE — no cloud to resurrect it, so no tombstone).
Cloud mode keeps its existing LS-overlay + push-queue behaviour untouched; gate
the standalone branch on `shouldUseBridge() && isStandalone()`.

**`isStandalone()` is cached** module-level (mode only changes on an app reload,
which the mode-switch wipe triggers, so the memo is always fresh).

# LOCAL-ONLY columns ride an LS meta overlay

SQLite `items_local` has no columns for units (multi-unit pricing), groupId,
nature, or itemType. These live in an LS overlay (`LS_KEYS.itemMeta`) keyed by
SQLite item id, applied in `listItems` (no-op in cloud mode, where the overlay is
empty). This is the same overlay reasoning as `pos-desktop-overlay-pattern`, but
scoped to the missing columns instead of superseding the whole row.

# Migrate legacy pure-LS rows or they can't be edited

A one-time `migrateLegacyItems()` (flag-guarded) moves old LS-only rows into
SQLite. **Why it's required:** standalone `updateItem`/`deleteItem` key off the
SQLite rowid; an LS row whose id isn't in SQLite would make `update_local_item`
affect 0 rows and the edit silently vanishes. Only set the migrated flag when
EVERY pure-LS row landed in SQLite — if any insert fails, leave the flag unset so
the next `listItems` retries (don't mark done on partial success).

# Don't show DEV_DEMO in a real install

`listItems`' empty-state DEV_DEMO fallback is gated to `!IS_TAURI` — a real
install (cloud or standalone) must never show fake demo rows that can't be sold
or synced.

Remember: Rust compiles only in CI; new bridged item commands also need lan.rs
dispatch arms (see `pos-desktop-lan-mode.md`).
