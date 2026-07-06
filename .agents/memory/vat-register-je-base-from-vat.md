---
name: VAT register — manual-JE rows are PER-LINE, base from the line's VAT
description: purchases-vat-register emits one row per manual-JE VAT-input line; base=lineVAT/rate; JE form must not inherit supplier across lines
---

## Report side — `GET /api/reports/purchases-vat-register` (`reports.ts`)

For rows sourced from **manual journal entries** (non-auto entries hitting the
input-VAT account 11071 / vat_input mapping):

1. **Emit ONE register row PER VAT-input LINE — never aggregate per entry.**
   A single manual JE routinely records several distinct purchases, each on its
   own input-VAT line with its own supplier ⋮ metadata (e.g. 50 / 60 / 90 for
   three different suppliers). The accountant needs each purchase on its own row
   with its own supplier/invoice#/date. `.orderBy(sortOrder, id)` keeps same-entry
   rows in line order; frontend keys rows by unique `serial` (rows from one entry
   share the same numeric `id`, so never key on `id`).

2. **Base = that line's VAT / standard rate (0.15), NOT total entry debits.**
   `journal_entry_lines` stores only the VAT *amount* (debit on the input-VAT
   account) — there is NO per-line taxable base or rate column. Summing all entry
   debits wrongly inflates the base when the JE mixes taxable + non-taxable lines
   (classic: a money-transfer principal ~600 alongside a few-piaster VAT). KSA
   standard 15% is assumed; the VAT total (what matters for the return) is exact
   regardless.

3. **Policy: positive purchase lines only.** Lines with `vat = debit − credit
   <= 0.005` are skipped. This means a negative (correction/contra) VAT-input line
   in the SAME entry is dropped rather than netting down a positive line — matches
   the user's "list each purchase line" intent. If strict reconciliation with the
   input-VAT account net movement is ever required, include negatives as negative
   adjustment rows (switch guard to `Math.abs(vat) <= 0.005`) — a deliberate policy
   change, ask first.

## Form side — `JournalEntryForm.tsx` `addLine()`

`addLine()` must start each new line with **EMPTY** supplier tax metadata. Do NOT
inherit the previous line's supplier (that silently mis-attributes tax when one
entry records purchases from different suppliers — one supplier per VAT line).
Description inheritance (البيان العام) stays. `hasSupplierTaxDetails` is no longer
used by the form.
