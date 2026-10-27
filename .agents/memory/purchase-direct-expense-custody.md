---
name: Purchase direct-expense and custody boundary
description: Rules for purchase invoice direct-expense lines, employee-custody settlement, and source-linked returns.
---

Direct-expense invoice lines are an opt-in, per-company capability that defaults off. They debit the selected company-owned posting expense account, use the invoice tax flow, and must never create inventory movements. Keep inventory, service, fixed-asset, deferred-expense, manufacturing, project, documentary-credit, and goods-receipt behavior unchanged.

Employee-custody payments must use the existing employee-custody account, disbursement, balance, and settlement lifecycle. Link the settlement to its purchase invoice/return so unposting reverses it atomically and a custody-paid supplier return restores the custody balance.

Purchase returns must remain source-linked and reverse only the source amounts actually posted, including tax and direct-expense account values. Disabling the company option hides new entry paths but must not alter saved documents or history.

**Why:** The user approved reusing existing accounting and custody lifecycles and explicitly required default-off behavior, historical safety, and restoration of custody value on returns.

**How to apply:** Preserve these boundaries when changing purchase invoice forms, posting/unposting, returns, reports, or the company setting; do not create parallel expense or settlement flows.
