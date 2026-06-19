---
name: POS Desktop data-folder relocation
description: Atomic ordering rule for moving the offline SQLite data folder + how the override pointer works
---

# POS Desktop configurable DB location

The offline pos.db location can be moved off the default `%APPDATA%\com.zacoderp.pos`.
A tiny pointer file `datadir.cfg` lives in a FIXED `config_root()` (dirs::config_dir,
never relocates); `db::data_root()` reads it on every launch and falls back to the
default when the file is missing or points at a non-existent dir.

## Rule: commit the pointer LAST
`backup.rs::data_dir_set` must: checkpoint(WAL) → resolve destination WITHOUT
touching the pointer → `create_dir_all` → copy old→new (only when `old.exists() &&
!new.exists()`) → THEN `set_data_dir_override` → then best-effort remove old file.
If the pointer write fails after a successful copy, roll the copy back.

**Why:** if the pointer is written before the copy and the copy then fails (no perms,
disk full, dest holds a db), the next launch resolves to the new EMPTY/foreign folder
and the user is stranded away from their real database. Pointer-last keeps the app on
the original db whenever any step fails.

**How to apply:** any future "move data folder" / "switch DB" path must preserve this
ordering and the don't-clobber guard. Reverting passes `None`/"" → removes the pointer.

## Auto-backup limitation (stated in UI)
Auto-backup runs from a background thread started in main.rs::setup — once-per-day,
after the scheduled HH:MM, ONLY while the app is open. A closed app cannot back itself
up; it takes the backup at first launch after the scheduled time that day.
