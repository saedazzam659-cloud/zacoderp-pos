---
name: POS Desktop per-user screen permissions
description: Keep permission edits staged, bulk changes save atomically, and inherited role defaults intact.
---

# POS Desktop per-user screen permissions

Edits in the per-user screen permissions page remain drafts until the administrator chooses Save. Global and group enable/disable actions change only that draft. Role defaults remain the inheritance baseline: persist only values that differ from the selected user's role defaults, and restore defaults by clearing those overrides.

**Why:** Bulk actions can change many screens at once, so saving a partial sequence would leave permissions inconsistent. Keeping edits staged also makes the requested Save action meaningful and lets the administrator review changes first.

**How to apply:** Save the known screen-key set and its overrides in one SQLite transaction. Replace only keys known to the current UI so older or future permission rows are preserved. When the signed-in user is edited, refresh both the cached allowed set and the shell's in-memory state. Keep browser-preview persistence separate from the native Tauri command path.
