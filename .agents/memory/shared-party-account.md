---
name: Shared party account («مورد عام» / «عميل عام»)
description: Many suppliers/customers may share ONE COA account; every account-based attribution path must detect and skip shared accounts; accountId is tenant-validated.
---

The rule: linking several suppliers (or customers) to one shared COA account is ALLOWED (quick-add dialogs offer an AccountCombobox that remembers the last pick per company in localStorage `quickAddLastAccount:<kind>:<companyId>`). The old 409 "account linked to another supplier" guards were removed by design.

**Why:** users with many small local parties don't want each one minted into the chart of accounts — they link them all to a shared «مورد عام»/«عميل عام» leaf.

**How to apply:**
- ANY logic that maps account_id → single party is now ambiguous. When an account is linked to >1 party of that type, SKIP account-based attribution entirely: /suppliers/balances direct-JE map, supplier statement direct-JE lines + opening jeNet (purchases-analytics `supplierAccountShared`), and JE settlement candidates (`partyAccountShared` in journalEntries — shared account ⇒ no candidates). New account-based features must add the same guard.
- Tenant guard: supplier/customer create & update must verify a client-supplied accountId belongs to the SAME company before persisting (was missing; cross-tenant link risk).
- Doc-based aggregation (invoices/returns/vouchers by party id) is unaffected — prefer it over account-based reads.
