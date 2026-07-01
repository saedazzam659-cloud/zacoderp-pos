---
name: Per-line supplier tax metadata
description: Where supplier tax details (name/VAT/invoice#/date) on PV & JE lines live and how they surface in VAT reports
---
Four additive text columns (`supplier_name`, `supplier_vat_number`, `supplier_invoice_number`, `supplier_invoice_date`) live on BOTH `payment_voucher_lines` (schema/cash.ts) and `journal_entry_lines` (schema/journalEntries.ts). Entered via the shared ⋮ SupplierTaxDetailsDialog on PV + JE line rows; new lines inherit the last-entered supplier block.

**Two independent surfacing paths — do not conflate:**
- **VAT declaration** (`reports.ts` → `supplierTaxLines[]`): built from posted PV lines (non-zero tax) + posted MANUAL JE VAT-account lines (auto-generated entryTypes excluded to avoid double-count). Rendered in BOTH TaxDeclaration.tsx and VATDeclaration.tsx.
- **Tax account statement** (`reports-accounting.ts` account-statement الشرح suffix): reads the metadata straight off `journal_entry_lines`. Fires for ANY entryType (not gated to manual). For this to cover PV-origin VAT, `buildPaymentJournal` in payment-vouchers.ts MUST copy the PV line's supplier fields onto the generated VAT-account JE line — the DR expense line and CR treasury line do NOT get it.

**Why:** objective required supplier data in BOTH the VAT declaration AND كشف حساب الضريبة; PV auto-JE lines originally dropped the metadata, so the account-statement path silently missed all PV entries.

**Gotcha:** any code building a `JournalLine` literal (frontend) or a jeLines entry (backend) now needs the 4 fields or tsc TS2739 fails — e.g. the JE form's auto-generated `vatLine` inherits them from its source line.
