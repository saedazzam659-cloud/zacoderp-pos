---
name: Bank cost-center lock
description: How to classify bank ledger accounts for the no-cost-center rule.
---

Bank-line cost-center locking must identify both a tenant's `bank_accounts` links and its general-ledger bank branch. The legacy/default COA can use `11021` as the bank root (with posting descendants such as `110211`), while other tenants can use `1102` or the configured bank-parent mapping.

**Why:** Existing/imported bank GL accounts may have no corresponding `bank_accounts` row, so entity-only detection lets a user retain a cost center on a real bank line. Classifying by account name would incorrectly catch unrelated assets.

**How to apply:** For any new journal-line producer or UI, treat a line as a bank line when it is linked to the tenant's bank entity or descends from the tenant's mapped / standard bank root. Preserve normal cost-center behavior for cash boxes, taxes, and the non-bank counterpart line.