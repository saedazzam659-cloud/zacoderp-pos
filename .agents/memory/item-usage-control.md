---
name: Item Usage Control (التحكم في توجيه الصنف)
description: Per-item × per-screen routing rules — storage/read invariants any enforcement phase must honor.
---

# Item Usage Control — storage & read contract

Per-item × per-screen routing rules live in `item_usage_controls` (companyId + itemId + screenKey unique). A row sets a `mode` for one item on one screen. The UI panel lives in the item form's "usage" tab; API is `GET/PUT /api/inventory/items/:id/usage-controls` gated by the existing `/items` pathRbac (GET→view, PUT→edit).

## Invariant: absent row = default ("allowed"); persist ONLY non-default rows
The PUT is a full-set replace (delete-all-for-item then insert) inside one transaction. It MUST drop any row whose `mode === "allowed"` **regardless of any reason supplied** — a reason on a default row is meaningless.

**Why:** the read helper `getScreenModesForItems()` filters `ne(mode,"allowed")`, so it never returns default rows. If PUT stored an `allowed`+reason row, `getItemUsageControls()` (returns everything) and `getScreenModesForItems()` would disagree for the same stored data, and the table would accumulate semantically-default rows that the "absence = allowed" model assumes never exist.

**How to apply:** in any write path (PUT replace, future bulk/Excel import in Phase ج), skip default-mode entries before insert. Enforcement (Phase ب, ~40 screens) should treat "no row" and "allowed row" identically = permitted.
