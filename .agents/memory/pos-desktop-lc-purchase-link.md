---
name: POS Desktop LC↔purchase link invariants
description: Rules for linking a purchase invoice to a Letter of Credit in the offline Tauri app
---

# LC ↔ purchase link invariants

When a purchase has `lc_id` set, posting credits the LC **settlement account** for the
goods (subtotal) portion; only VAT (if any) lands on the cash/bank/payable account. The
LC `used_amount` draws down by subtotal and status recomputes (open→partial→closed).

**Rule: the LC must belong to the same supplier as the purchase.**
**Why:** an LC is a per-supplier bank facility; posting supplier A's invoice against
supplier B's LC corrupts both the LC drawdown and the AP picture, and there is no later
guard to catch it.
**How to apply:** enforce in BOTH layers —
- Backend `apply_purchase_impact` (accounting.rs): query LC `supplier_id` alongside
  settlement_account_id/status and reject mismatch ("الاعتماد المستندي يخص مورّداً آخر").
- UI `PurchasesAdmin` LC picker: filter options to `lc.supplierId === supplierId`
  (still show the already-linked LC in edit mode), and an effect clears `lcId` when the
  supplier changes to one the LC doesn't belong to.

**Group code uniqueness:** `supplier_groups_local.code` uniqueness is app-enforced only
if a `UNIQUE INDEX` exists — the table definition alone does NOT make `code` unique. The
create/update handlers catch the UNIQUE violation to show "الكود مستخدم"; without the
index that catch never fires and duplicates slip through.
