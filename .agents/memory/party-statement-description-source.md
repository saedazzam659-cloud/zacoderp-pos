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

**How to apply (per statement):**
- **Supplier** (`purchases-analytics.ts` `/supplier-statement` + `-detailed`): has
  direct-JE rows → apply the manual-JE line-description rule AND the invoice rule.
- **Customer** (`sales-analytics.ts` `/customer-statement` + `-detailed`): has NO
  direct-JE rows (only invoice/return/receipt) → only invoice rows need item-name
  loading; returns/receipts keep the typed-note-or-"—" rule.
- **General accounts** (`reports-accounting.ts` `/account-statement`): the row
  description is the GL *line* text. For rows whose JE links a sales/purchase
  invoice (`salesInvoiceId`/`purchaseInvoiceId` already left-joined), OVERRIDE with
  item name(s) + ` — ` + invoice docNumber. NOTE: this override is unconditional
  for EVERY account touched by that invoice JE (AP/AR, inventory, VAT), not just
  the placeholder line — intentional (source-true) but surprising for VAT/inventory
  accounts; narrow to known-generic labels only if a user objects.

Batch item-name loading (`inArray` invoice ids, `companyId`-scoped, `orderBy id`,
dedupe via Set) — never per-row. The frontend (AccountStatementView / export
buttons) consumes `line.description` verbatim, so this is a backend-only change.
