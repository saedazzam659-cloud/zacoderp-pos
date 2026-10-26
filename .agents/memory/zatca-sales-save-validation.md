---
name: ZATCA sales-invoice save validation
description: Saudi tax invoices with incomplete ZATCA buyer details must be rejected before persistence, including draft saves.
---

Do not save a Saudi standard tax invoice when required ZATCA customer details are missing, even as a draft. Do not silently downgrade it to simplified; keep the validation consistent in the form, API save/update routes, and posting path.

**Why:** The product owner explicitly requires completion of ZATCA fields before any tax-invoice save, after a rejected invoice exposed a gap between client-side type selection and server-side VAT-based classification.

**How to apply:** Keep Saudi-specific checks scoped to Saudi companies/customers. If the invoice type and customer VAT data disagree, fail closed with actionable missing-field feedback rather than changing the invoice type.
