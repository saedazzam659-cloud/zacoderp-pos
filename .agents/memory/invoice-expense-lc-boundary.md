---
name: Invoice expenses and documentary credits
description: Preservation boundary for proposed invoice expenses alongside existing documentary credits and ZATCA.
---
Treat the existing documentary-credit workflow as a protected boundary when adding invoice expenses. Do not redesign its costing, settlements, or posting as part of that addition.

**Why:** The user explicitly confirmed that documentary credits work well and must not be disrupted by the proposed invoice-expenses feature.

**How to apply:** Inspect existing expense attribution before implementation; prevent the same expense being capitalized or posted through both documentary credits and invoice expenses. If integration requires changing the documentary-credit lifecycle, explain the dependency and obtain approval first. The proposed addition must also preserve the existing ZATCA flow.

New expense accounts and their posting mappings must be provisioned automatically when a new company is created, as part of the proposed feature.

**Why:** The user explicitly requires new companies to receive these defaults without manually recreating accounts or mappings.

**How to apply:** Extend the existing company-creation defaults with the eventual approved expense accounts and mappings, reusing appropriate default accounts rather than duplicating them. Do not reset existing companies' customized mappings.

Treat invoice-tab expenses as internal net-of-recoverable-VAT costs, not extra taxable invoice lines or automatic refunds on returns.

**Why:** The approved scope requires preserving ZATCA totals and separating existing LC landed costs from new internal costs; inventory received through a goods receipt must not be capitalized a second time through its later invoice.

**How to apply:** Keep capitalization unavailable for LC/receipt-linked purchases until a separately approved attribution design exists. Do not claim that a separate supporting VAT invoice can duplicate the already recognized net expense; any future payable/tax settlement UI must reconcile the accrued expense rather than recognize it again.