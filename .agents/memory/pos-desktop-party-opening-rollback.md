---
name: POS Desktop party opening-balance rollback + statement seeding
description: Why new customers/suppliers with an opening balance silently vanish in standalone, and why the customer statement can't see a posted opening JE.
---

# Party create: opening-balance JE rolls back the whole insert

`create_customer_local` and `suppliers_create` post the opening-balance JE in the
**same SQLite transaction** as the party INSERT. If that JE can't post (no open
fiscal period for the opening date, missing AR/AP control account in a freshly
seeded standalone COA, unbalanced, etc.) the whole transaction rolls back, so the
party is **never persisted** and never shows up in invoice pickers — with no error
surfaced to the user beyond a generic failure.

**Why:** standalone DBs only seed the current fiscal year, and a party opening
dated outside it (or against a missing account) trips `insert_journal_entry`,
which aborts the enclosing tx.

**How to apply:** the create wrappers (`createCustomer` in `customers.ts`,
`createSupplier` in `accounting.ts`) catch the failure and **retry the create
WITHOUT the opening** so the party at least persists; the opening is preserved in
a localStorage overlay. Do this for any future party type whose Rust create posts
an opening JE in-tx. Don't try to "fix" it by making the JE non-fatal inside the
single Rust tx — the retry keeps the party row even when the JE genuinely can't
post yet.

# The customer statement is document-based — it never reads the opening JE

`CustomerStatementReport` builds every line in TS from source documents
(credit invoices / credit returns / receipt+payment vouchers). It does **not**
read the GL. So even a *successfully* posted opening-balance JE is invisible
there. The opening row is seeded from the customer-opening LS overlay
(`getCustomerOpening`), gated to `includeOpening && openingDate < fromDate`.
This does NOT double-count document movements (the overlay is the initial
balance; documents are subsequent activity). Seed the overlay on create whenever
`openingBalance > 0`, regardless of whether the JE posted.
