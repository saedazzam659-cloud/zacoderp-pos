---
name: POS Desktop credit overdue check (FIFO)
description: How the standalone POS Desktop sales overdue/credit guard must be computed and gated
---

The standalone POS Desktop `sales_invoice_create` credit guard has two independent checks.

**Rule:**
- **Credit-limit cap** runs ONLY when `enforce_credit_limit != 0` (and `credit_limit > 0`): reject if `balance + grand > limit`.
- **Overdue check** runs whenever `payment_terms_days > 0 && balance > 0` — it is NOT gated by the credit-limit toggle. They are separate policies.
- The overdue check must find the oldest *still-unpaid* credit invoice via FIFO, NOT `MIN(invoice_date)` over all credit invoices. Settle oldest-first with `settled = max(0, total_credit_invoiced − balance)`, walk invoices oldest-first subtracting each `grand_total` from the settled pool; the first invoice not fully covered is the oldest unpaid one — test ITS age against terms.

**Why:** A raw `MIN(invoice_date)` over all credit invoices rejects customers who long-since paid old invoices but carry a small recent balance. Gating overdue behind `enforce_credit_limit` also wrongly disables the terms policy when a company only wants term enforcement, not a hard limit.

**How to apply:** Mirror this exact logic in any place that re-implements credit control (e.g. cloud zatca side already uses the same FIFO-oldest-unpaid intent — see replit.md "Customer Payment Terms"). The `stmt`/`query_map` borrow of `tx` must live in its own `{ }` block so it drops before later `tx` inserts.
