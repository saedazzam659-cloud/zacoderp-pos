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
  - **Receipt/payment voucher rows** (`receiptVoucherId`/`paymentVoucherId`, also
    already left-joined): MERGE all typed voucher text with `mergeDesc(...parts)`
    (join non-empty, de-duped pieces with `" — "`). Order: البيان العام (voucher
    HEADER `description`) → بيان البند (this JE *line*'s own `description`, i.e.
    `r.description`) → الملاحظات (voucher `notes`). Then fall back to
    `"سند قبض/صرف — <entityName>"` (الطرف الثاني) only when all three are empty.
    The per-line piece is BLANKED when it is a system label — empty, equal to the
    header, or `startsWith` `"سند صرف"`/`"سند قبض"` (the auto expense-line fallback)
    or legacy `"بنك "`/`"صندوق "` treasury labels — because old journal rows may
    still contain those and they would be noise.
    Same unconditional-per-account-line caveat as invoices (fires on every account
    the voucher JE touches — treasury side AND counter-party/expense side).
    Precedence: invoice override wins, then this voucher merge, then raw GL text.
  - **HR employee-custody rows:** resolve the custody source by the direct
    disbursement JE link or through its settlement row. Override the generic GL
    line with movement type + employee name + custody purpose; settlement rows
    may append their own settlement description. Keep this source-driven so
    legacy JEs also improve without reposting.

**Voucher merge (the durable rule):** voucher statement rows show the FULL typed
text, not header-only. `mergeDesc` = join non-empty deduped pieces with `" — "`:
- **General** (`reports-accounting.ts`): header + per-line-JE-desc (system labels
  skipped, see above) + notes.
- **Cash/Bank** (`cash-analytics.ts buildAccountStatement`): header + notes (one
  row per voucher, no per-line), fallback `"سند قبض/صرف — <entityName>"`.
- **Customer/Supplier simple** (`sales-analytics.ts`/`purchases-analytics.ts`
  `/customer-statement`,`/supplier-statement`): header + notes via `voucherDesc()`,
  fallback `"—"`. This FIXED a bug where they showed ONLY notes via `withNote`.
  `withNote` is KEPT for RETURN rows. The voucher SELECT must add `description`
  (and `notes` where missing) or the merge silently drops the header text.
- **Out of scope (still header-label-only):** the `-detailed` variants
  (`/customer-statement-detailed`,`/supplier-statement-detailed`) still hardcode
  `"سند قبض"`/`"سند صرف"` on voucher rows — intentionally left per the confirmed
  plan; revisit only if a user asks for the merge there too.

Batch item-name loading (`inArray` invoice ids, `companyId`-scoped, `orderBy id`,
dedupe via Set) — never per-row. The frontend (AccountStatementView / export
buttons) consumes `line.description` verbatim, so this is a backend-only change.

## Generated journal-line descriptions

**Rule:** generated JE lines must describe the source business fact, not repeat
the GL account label. Supplier/custody treasury lines name the beneficiary;
receipt customer lines prefer the voucher's entered general description; sales
revenue lines name the sold items; sales-output-VAT lines carry the invoice
number from the JE header; project/service purchase lines carry item + supplier.

**Why:** repeating “bank”, “cash sales”, or “VAT output” adds no reconciliation
value because the account column already says that, and it leaves tax statements
without the invoice reference users need.

**How to apply:** write source-driven text when the JE is created so journal
views, general account statements, exports, and printing all inherit it. Keep
statement-side source overrides for historical rows created before this rule.
