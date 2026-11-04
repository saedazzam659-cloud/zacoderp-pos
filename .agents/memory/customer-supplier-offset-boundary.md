---
name: Customer–supplier offsets
description: Boundaries for offsetting a customer receivable against a linked supplier payable.
---

Only allow an offset between customer and supplier records explicitly connected through the shared-party identity feature. Keep customer receivables and supplier payables as distinct records and ledgers; do not infer a match from names or merge prior balances. The offset feature must be controlled by a company-level General Settings option that defaults off. Offsets are not cash or bank payments and must remain traceable to both parties and the purchase document, with reversal support. Restrict to a shared company and currency, and never alter purchase tax or inventory posting.

**Why:** The user approved the offset only as a controlled opt-in on already-linked records and specifically requested that the setting be closed by default. Cross-ledger amounts affect fiscal balances and must not silently change legacy behavior.

**How to apply:** Gate both the purchase-invoice UI and server posting/validation with the company flag. Validate the linked customer, available receivable, payable amount, tenant, currency, and duplicate/reversal state in the authoritative server transaction.
