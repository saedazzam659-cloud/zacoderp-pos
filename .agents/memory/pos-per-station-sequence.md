---
name: POS per-station invoice sequence
description: Cloud-POS sales doc numbering is per pos_terminal and must never touch the ZATCA crypto chain.
---

POS-screen sales invoices (cloud POS, `artifacts/pos` → backend `POST /api/sales/sales-invoices`) get their human `docNumber` from a **per-station** sequence resolved from `posSessionId` → `pos_terminal`. The series is auto-created on first use; prefix carries branch+terminal code (`BRANCHCODE-TERMINALCODE-`, fallback `POS<id>-`). Helper: `nextPosStationNumber(companyId, posSessionId, ctx)` in `lib/sequences.ts`; sales route falls back to `nextSequenceForPayment("sales_invoice",...)` when no `posSessionId`.

**Why:** stations need distinguishable invoice numbers, but ZATCA ICV/PIH is ONE chain per company/CSID. Forking numbering must change only the printed human number.

**How to apply:** any new POS numbering/scope change touches `docNumber` ONLY. The ICV (`MAX(zatcaIcv)` scoped by `company_id`) and PIH (prior `invoiceHash` scoped by `company_id`), computed at `zatca-submit`, must stay company-wide and untouched. Same principle as per-payment-type doc numbering.
