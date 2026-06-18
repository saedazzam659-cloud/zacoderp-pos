---
name: Sister-company draft edit invariants
description: Rules for safely editing DRAFT sister-company transfer/return/settlement docs before they post a JE/stock.
---

# Editing draft source documents (sister-companies)

Draft sister-company docs (transfers/returns/settlements) are editable; posted ones lock
(they already wrote JE/stock/returnedQty). When adding an edit (PUT) path for any
source document whose POST mutates ledgers, enforce these invariants or you get
silent data corruption that only surfaces at post time:

- **Require the FULL child set on edit, never a partial header-only update.** A return
  whose header `transferId` changes while old line rows survive desyncs the doc:
  lines point at transfer A items, header at transfer B. Mirror create semantics —
  reject when `items` is empty, then clear-and-reinsert all lines.
- **Re-validate tenant ownership of every mutable FK on the draft PUT**, not just on
  POST. A draft can otherwise persist a cross-tenant/invalid cash-box, bank-account,
  warehouse, or sister-company id. (POST blocks it later, but the draft is still dirty.)
- **Add a defensive consistency check INSIDE the post handler**, before any stock/JE
  mutation: every child line's parent ref must still belong to the header parent.
  Belt-and-suspenders against a desynced draft ever posting.

**Why:** draft create has zero side-effects (stock/JE/returnedQty only on POST), so a
draft PUT feels safe — but a header/line mismatch saved as draft becomes corruption
the moment someone posts it.
