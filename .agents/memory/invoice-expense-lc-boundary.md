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