---
name: POS Desktop stock-ledger erase on unpost
description: Unposting/deleting a stock document must ERASE its ledger rows and recompute, never append reversing counter-rows.
---

# Erase-and-recompute, not void-counter rows

When a stock document is unposted or deleted, its effect on the stock ledger
(`stock_ledger_local` → حركة المخزون) must be **erased**, exactly like the JE is
deleted on unpost — NOT reversed by appending a `*_void` counter-row.

The old design pushed a reversing `"<reftype>_void"` row on unpost and a fresh
row on re-post, so each post⇄unpost cycle left **2 residue rows** and the
movement screen grew without bound.

**The fix:** `inventory::ledger_remove_ref_in_tx(tx, ref_type, ref_id)`:
1. collect affected `(item_id, warehouse_id)` pairs for the doc,
2. DELETE the doc's ledger rows,
3. recompute `balance_after` for each pair as the cumulative `qty_delta` in
   `id ASC` (insertion) order over the remaining rows,
4. refresh the `stock_on_hand_local` cache to the final running balance (0 if
   the pair has no rows left).

Called from the 4 reverse/delete sites in `accounting.rs` (`purchase`,
`goods_receipt`, `sale`, `goods_delivery`) in place of the old void pushes.

**Why:** `balance_after` is pure cumulative qty in insertion order, so deleting a
doc's rows and replaying the remainder yields the same balances as if the doc
never existed — this is only valid because nothing keys off the deleted rows.

**How to apply:**
- Any new stock-posting doc type must call `ledger_remove_ref_in_tx` on its
  unpost/delete path, inside the SAME tx as the rest of the reversal.
- Never reintroduce `*_void` ref_types. There are no external readers of them.
- Helper is a safe no-op when the doc pushed nothing (e.g. GR-sourced purchases,
  still also guarded by `gr_src.is_none()`).
- Returns paths use create-side push only — unaffected.
