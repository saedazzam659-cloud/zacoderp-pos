---
name: POS Desktop LS overlay pattern for cloud-pulled catalog rows
description: Updating/deleting cloud-pulled items/customers without Rust write commands requires a localStorage overlay that supersedes SQLite at read time + soft-delete tombstones.
---

Rule: as long as the Tauri shell has no write commands for `items_local` / `customers_local`, mutations to cloud-pulled rows MUST go through a localStorage overlay layer, not direct SQLite writes.

Strategy:
- **List (read):** merge SQLite + LS, but LS WINS when both reference the same row (match by `id` OR by `cloudId`). Pure-LS rows with no SQLite peer are additive.
- **Update:** write a full row to LS (not just the patch) so the next call finds the overlay and the merge correctly supersedes the SQLite version.
- **Delete:** write a soft-delete tombstone (`deleted: true`) for cloud-backed rows; physically remove LS-only rows. The merged list filters tombstones at the end.

**Why:** without the overlay, `update*` silently no-oped because `findIndex` against the LS array failed for any row originating from SQLite. The bug user-facing symptom was "الإضافة تعمل، التعديل لا يعمل" — adds wrote to LS and showed up via the merge; edits/deletes returned `null` and the UI assumed success while the row was untouched.

**How to apply:** any new entity that follows the same Tauri-pull-then-edit-locally pattern (uoms, branches, terminals…) needs the same three pieces in lockstep. Tombstones intentionally survive subsequent `upsertXFromCloud` pulls — the local delete is treated as authoritative. If the product later wants "server-restores-deleted-row" semantics, the upsert path must clear the `deleted` flag for the matching cloudId.
