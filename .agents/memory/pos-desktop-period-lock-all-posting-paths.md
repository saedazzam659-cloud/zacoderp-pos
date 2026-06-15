---
name: POS Desktop fiscal period-lock must cover ALL posting paths
description: Every Rust path that persists a journal entry as status='posted' (or reverses a posted one) must call the period-lock guard, not just post_je_core/unpost_je_core.
---

The fiscal period-lock guard (`guard_period_open_for_date` / `guard_period_open_for_entry`) rejects moving GL balances in a soft/hard-closed period. The shared `post_je_core` / `unpost_je_core` (used by the Posting Center and the manual post/unpost commands) call it — but those are NOT the only paths that touch GL.

`journal_entry_create` and `journal_entry_update` can persist an entry directly as `status='posted'` and apply GL via `write_manual_lines(..., post=true)` (and `_update` also reverses the prior posted balance). These bypass `post_je_core`, so the guard must be added explicitly:
- create-as-posted → `guard_period_open_for_date(&tx, &input.entry_date)` before consuming the sequence number.
- update → guard the OLD entry (`guard_period_open_for_entry`) when `old_status=="posted"` (the reverse moves GL) AND guard the new `entry_date` when the new status is posted.
- Drafts touch no GL and must remain allowed in any period.

**Full-lock policy (option A):** the guard ALSO rejects when NO fiscal period covers the date (Arabic "الرجاء إنشاء فترة مالية") and when the date's fiscal YEAR (not just the period) is closed/permanently_closed. Every back-office financial create/post/delete handler must guard its own date field (`input.*_date`) inside its existing tx. As of the full-lock work, all of these guard: purchase create/update/delete, purchase_return_create, goods_receipt create/post, sales_invoice create/update/delete, sales_return_create, financial_tx_create (vouchers), treasury_transfer_create, journal_entry create/update/delete, supplier_settlement create/post/delete **and unpost**, lc_post_funding.

**Reverse/unpost paths are GL-moving too.** `supplier_settlement_unpost` was the gap an architect caught: it calls `reverse_je_balance` + deletes the JE but had NO guard, so a closed-period settlement could be unposted (mutating closed-period balances). Any `*_unpost`/reverse path must load its source-doc date in-tx and guard before reversing. (The `reverse_purchase_impact` / `reverse_sales_invoice_impact` private helpers are exempt only because EVERY caller — purchase/sales create/update/delete — already guards the date before calling them.)

**Deliberate exclusion:** `lc_expense_create`/`_update`/`_delete` are NOT guarded — they only insert into `lc_expenses_local` and post NO journal entry and carry NO date column, so the period lock does not apply.

**Blast radius:** `insert_journal_entry` is called ONLY from `accounting.rs`; the offline POS register (invoices.rs/sync.rs/standalone.rs) does NOT post local JEs, so the period guard never blocks cashier sales — only back-office accounting.

**Why:** an architect review caught that closed-period protection was enforced only on the Posting Center / manual post-unpost paths, leaving the create/edit-as-posted manual JE paths able to write into a permanently-closed period.

**How to apply:** whenever you add or modify a Rust path that inserts/updates a JE with `apply_balance`/`reverse_je_balance` outside `post_je_core`/`unpost_je_core`, add the period guard in lockstep. Same trap class as the path-to-regexp literal-segment ordering one: easy to miss because the happy path compiles and works.
