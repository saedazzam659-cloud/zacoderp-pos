---
name: ZATCA sales-invoice save validation
description: Saudi tax invoices with incomplete ZATCA buyer details must be rejected before persistence, including draft saves.
---

Do not save a Saudi standard tax invoice when required ZATCA customer details are missing, even as a draft. Do not silently downgrade it to simplified; keep the validation consistent in the form, API save/update routes, and posting path. A simplified cash/bank invoice may be saved without a customer at any amount; credit sales still require one.

**Why:** The product owner explicitly requires completion of ZATCA fields before any standard tax-invoice save, after a rejected invoice exposed a gap between client-side type selection and server-side VAT-based classification. They also explicitly removed the 1,000 SAR cap for customerless simplified cash/bank invoices.

**How to apply:** Keep Saudi-specific checks scoped to Saudi companies/customers. If the invoice type and customer VAT data disagree, fail closed with actionable missing-field feedback rather than changing the invoice type. Do not restore a customerless amount threshold for simplified cash/bank sales; retain customer requirements for standard and credit invoices.
