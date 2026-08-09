---
name: Party balances ↔ statement parity
description: Supplier/customer balances reports must replicate the statement formula exactly; invoice payment-status mirrors the settlement engine.
---

**Rule:** أرصدة الموردين/العملاء pages read the bulk `/purchases-analytics/supplier-balances` and `/sales-analytics/customer-balances` endpoints, which replicate the statement (كشف حساب) closing formula verbatim — RAW document amounts, NO exchange-rate conversion (the statement itself sums document currency), display-only parties excluded, supplier side adds direct-JE net on unshared AP accounts. Never repoint these pages to the aging endpoint (a third formula) or `/customers/balances`.

**Payment-status reports** (`/invoice-payment-status`, purchases + sales): `paid` mirrors the settlement engine — voucher lines (PV lines amount+tax, RV lines amount only) + header-linked vouchers not line-linked + settlement_links × source rate + legacy JE header links, all base currency, POSTED sources only (deliberate divergence from the engine's draft+posted cap). Lines and links from the SAME voucher are BOTH counted by design — links are minted only from the voucher's unallocated residual, so this is not double counting. Paid sources are invoice-scoped, not branch-scoped (payments follow the invoice).

**How to apply:** any new balances/paid computation must copy the statement or `lib/invoiceSettlement.ts` math, not invent a fourth formula. Frontend balance pages must render ONLY endpoint rows (never merge the full party list back in — that resurrects display-only parties with 0 balances).
