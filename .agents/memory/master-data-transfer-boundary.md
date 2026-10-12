---
name: Company master-data transfer boundary
description: Scope and safety rules for copying setup data between companies.
---

Cross-company setup transfer is limited to chart of accounts, branches, warehouses, cashboxes, customers, suppliers, and items. It must not transfer invoices, journal entries, opening balances, stock balances, or operational transactions.

Match records using company-local business codes, never source-company database IDs. Preserve the chart hierarchy by resolving each account's parent through its account code, independent of spreadsheet row order. Party imports must retain or create/reuse their ledger account link.

**Why:** The user explicitly clarified that they are copying company setup, not transaction history; importing operational records would be out of scope and could alter financial or inventory history.

**How to apply:** Keep the dedicated transfer UI restricted to the seven master-data types. Do not include balances or transaction entities without explicit user approval.
