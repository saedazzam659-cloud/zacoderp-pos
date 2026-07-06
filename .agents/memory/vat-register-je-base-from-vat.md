---
name: VAT register — JE-sourced taxable base must come from the VAT amount
description: Why the purchases-VAT-register base for manual-JE rows is VAT/rate, not total entry debits
---

For the Local Purchases VAT Register (`GET /api/reports/purchases-vat-register`,
`reports.ts`), rows sourced from **manual journal entries** must derive the
taxable base as `base = inputVAT / standard rate (0.15)`, NOT as
`totalDebits(entry) − vatLineDebit`.

**Why:** a manual JE frequently mixes a taxable purchase line with non-taxable
amounts in the SAME entry — the classic case is a money-transfer (حوالة) where
the ~600 transfer principal is debited alongside a tiny fee whose VAT is a few
piasters. Summing all debits made the base ≈ the whole transfer (e.g. base 600.50
for VAT 0.08 → nonsense 0.01% effective rate). The user's rule: show ONLY the
VAT-derived value of the entry, never the entry's full value.

**How to apply:** `journal_entry_lines` stores only the VAT *amount* (the debit on
the input-VAT account 11071 / vat_input mapping) — there is NO per-line taxable
base or rate column. So the only defensible base is VAT/rate. KSA standard rate
is 15% (every doc-type `vat_rate` column defaults to "15"); JE VAT lines carry no
rate, so 15% is assumed. The VAT total (the number that matters for the return)
is always exact regardless of the base assumption. Supplier name / VAT# / invoice
number+date for JE rows come from the per-line ⋮-dialog metadata on the VAT line
(often blank for commission/transfer JEs — expected).
