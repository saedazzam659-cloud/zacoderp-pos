---
name: Supplier balance JE aggregation
description: Rules for which journal entries count in GET /api/suppliers/balances and why the exclusion list must match actual writers.
---

# Supplier balance JE aggregation

**Rule:** In `/api/suppliers/balances`, the direct-JE aggregation may exclude an `entryType` ONLY if that document type is aggregated from its own table in the same formula. Before excluding a type, verify the doc flow actually WRITES the table you think covers it.

**Why:** `entryType='payment'` (سندات الصرف) was excluded on the assumption payment vouchers write `supplier_settlements` rows — they never do (JE-only; the settlements screen is a separate manual flow that posts NO JE). Result: voucher payments silently vanished from supplier balances (~95K SAR in prod). Verified zero overlap between settlements rows and payment JEs in both dev and prod before including 'payment'.

**Also:** the balances endpoint must include display-only suppliers (`include_in_statements=false`) — that flag filters statement/aging REPORTS only. Hiding the list-balance behind "—" made users think their JEs were lost. Note the flag is not exposed in the inline Suppliers.tsx edit form, so users can't see or flip it themselves.

**How to apply:** when adding a new supplier-touching document type, either aggregate it from its own table AND exclude its entryType, or let its JE flow through the direct-JE bucket — never both, never neither. Same pattern applies to the customers balances endpoint (it filters display-only via `displayOnlyIds`; entry types differ).

**Related:** entryType spelling is inconsistent in the wild — payment vouchers write `'payment'` (payment-vouchers.ts) but the JE source-doc maps also know `'payment_voucher'`; check both when filtering.
