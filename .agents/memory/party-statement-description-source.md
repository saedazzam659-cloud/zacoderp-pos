---
name: Party statement البيان loads from source
description: How supplier/customer/general account-statement description columns should source their text
---

# Account-statement "الشرح/البيان" must load from the source document

**Rule:** in party/account statements, the description column is sourced from the
originating document, NOT a generic label:
- **Manual / direct JE rows** → prefer the journal *line* description
  (`journal_entry_lines.description` on the party's AP/AR line) over the entry
  *header* description; only fall back to a type-specific label (`jeLineLabel`)
  when both are empty. Reading the entry-header description shows the wrong text;
  the user types the meaningful note on the line.
- **Invoice rows** → typed header note if present, else the invoice's deduped
  item name(s) joined by `، `, else `—` (or the generic payment-type label in
  the detailed view).

**Why:** users complained the supplier statement showed "قيد يومية يدوي" for
manual JEs and "—" for invoices with no header note — useless for reconciliation.

**How to apply:** done for the **supplier** statement (`purchases-analytics.ts`
`/supplier-statement` + `/supplier-statement-detailed`). Same pattern still TO DO
on the **customer** statement (`sales-analytics.ts` — note it currently shows NO
direct-JE rows at all, only invoice/return/receipt) and the **general accounts**
statement (`reports-accounting.ts` `/account-statement`, request was to replace
"مستحقات المورد" with item name + invoice number). Mirror the same fallback chain.
The frontend (AccountStatementView / export buttons) consumes `line.description`
verbatim, so this is a backend-only change.
