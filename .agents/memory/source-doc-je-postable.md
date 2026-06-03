---
name: Source-document JEs must stay postable
description: Locked auto-generated journal entries must remain manually postable, or auto-posting-OFF companies strand drafts out of all financial reports.
---

# Source-document journal entries must stay postable

Journal entries whose `entryType` is a source-document type (the LOCKED_ENTRY_TYPES
set in `routes/journalEntries.ts` — e.g. `sales_invoice`, `purchase_invoice`,
`goods_receipt`, vouchers, POS, payroll, production) are normally inserted
already `posted`. But when a company has the master auto-posting switch
(`companies.auto_posting_enabled`) OFF, `resolvePostingStatus` returns `"draft"`
for **every** JE including these, so the source-doc JE is created as a draft.

**Rule:** `POST /api/journal-entries/:id/post` MUST accept locked entry types and
flip draft → posted (status-flip only, still enforcing balance + ≥2 valid lines +
open period). Only `PUT /:id` (edit), `DELETE /:id`, and `POST /:id/unpost` stay
locked for these types.

**Why:** Per the "Posted-Only Financial Reports" rule, draft JEs have zero impact
on trial balance / balance sheet / income statement / account statement. If
`/post` rejected locked types, a company with auto-posting OFF would create a
source-doc JE as draft that **no screen could ever post** — the document's
financial effect would be permanently invisible. Posting via the JE screen does
not corrupt the source doc because it only changes `status`, not amounts/accounts.
Editing/deleting/unposting are the operations that could desync the JE from its
source, so those stay locked.

**How to apply:** When adding a new source-document entryType, add it to
LOCKED_ENTRY_TYPES, and confirm `/post` still allows it (the `ensureNotLocked`
gate must NOT run on `/post`). Regression coverage:
`__tests__/journal-entry-locked-post.test.ts`.
