---
name: Posting-center bulk unpost cascade
description: Why posting_center_unpost must pre-validate the whole selection before mutating any entry, and how source-doc JEs are routed.
---

Posting Center "unpost" of selected JEs must **pre-validate the entire selection
BEFORE unposting any of them**, then mutate in a second pass.

**Why:** each per-document unpost (purchase_unpost / sales_invoice_unpost /
supplier_settlement_unpost) and each manual draft-flip opens and COMMITS its own
transaction. There is no cross-document rollback. If validation were folded into
the mutation loop, hitting a blocked source type mid-list would return Err only
*after* earlier documents were already unposted — a partial bulk outcome with an
error response. A separate up-front validation pass makes the batch all-or-nothing
with respect to the "unsupported source type" rejection.

**How to apply:** in `accounting.rs::posting_center_unpost`, the validation loop
(skip non-`posted`, allow manual/NULL/purchase/sale/sale_cogs/supplier_settlement,
else Err) runs first; the mutation loop runs second. Source-doc JEs cascade to the
document's full unpost (reverse GL+stock, DELETE JE, doc→draft) — never
`unpost_je_core`, which would leave a stray draft out of step with the document.
Dedup sale + sale_cogs legs via a `HashSet<(doc_kind, source_id)>` (normalize
`sale_cogs`→`sale`) so selecting both legs unposts the sale once.
