---
name: POS Desktop fiscal hard-close posted invariant
description: Closing-entry existence checks in the fiscal-period close must filter status='posted', because Posting Center can unpost any JE.
---

The fiscal-period **hard-close** validation must count its required closing
entries (`closing_revenue`/`closing_expense` and `closing_transfer_*`) with an
explicit `status='posted'` filter — never a bare `COUNT(*)` by `entry_type`.

**Why:** مركز الترحيل (Posting Center) `posting_center_unpost` can flip ANY
journal entry back to `draft`, including the closing JEs the wizard generated.
A draft closing entry has zero GL effect. If hard-close counts drafts as
satisfying the closing requirement, a period can be permanently_closed with an
incomplete/incorrect close — an irreversible (except force-reopen) corruption.

**How to apply:** Any "did the closing cycle run?" existence check, in Rust
(`fiscal.rs fiscal_period_hard_close`) or the web api-server equivalent, gates on
posted status. The pre-close unpost path (period still `open`) is only caught
here at hard-close; once a period is `closed`, `guard_period_open_for_date`
already blocks unposting entries dated in that period. The same posted-only
principle is the "Posted-Only Financial Reports" rule applied to the close.
