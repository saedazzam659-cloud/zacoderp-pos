---
name: POS employee meal boundary
description: Employee meal valuation, accounting, daily limits, and stock/cash boundaries in POS.
---

Employee meals use a company-configured fixed cost per meal, a meal expense account, and a dedicated clearing account. Issuing a meal must not reduce the POS till or inventory. Each issue creates one source-linked draft journal entry (expense debit, clearing credit) for normal accounting review/posting, rather than silently creating another posted entry.

**Why:** The user explicitly chose fixed meal cost and a dedicated clearing account, while requiring duplicate-posting prevention and no stock deduction without an approved issue flow.

**How to apply:** Keep per-employee daily limits and same-day/type duplicate prevention at the server boundary. Preserve the issuer and timestamp, retain the account IDs used on each meal record, and route any journal posting through the existing journal-entry permissions and lifecycle.
