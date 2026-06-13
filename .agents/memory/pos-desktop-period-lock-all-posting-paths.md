---
name: POS Desktop fiscal period-lock must cover ALL posting paths
description: Every Rust path that persists a journal entry as status='posted' (or reverses a posted one) must call the period-lock guard, not just post_je_core/unpost_je_core.
---

The fiscal period-lock guard (`guard_period_open_for_date` / `guard_period_open_for_entry`) rejects moving GL balances in a soft/hard-closed period. The shared `post_je_core` / `unpost_je_core` (used by the Posting Center and the manual post/unpost commands) call it — but those are NOT the only paths that touch GL.

`journal_entry_create` and `journal_entry_update` can persist an entry directly as `status='posted'` and apply GL via `write_manual_lines(..., post=true)` (and `_update` also reverses the prior posted balance). These bypass `post_je_core`, so the guard must be added explicitly:
- create-as-posted → `guard_period_open_for_date(&tx, &input.entry_date)` before consuming the sequence number.
- update → guard the OLD entry (`guard_period_open_for_entry`) when `old_status=="posted"` (the reverse moves GL) AND guard the new `entry_date` when the new status is posted.
- Drafts touch no GL and must remain allowed in any period.

**Why:** an architect review caught that closed-period protection was enforced only on the Posting Center / manual post-unpost paths, leaving the create/edit-as-posted manual JE paths able to write into a permanently-closed period.

**How to apply:** whenever you add or modify a Rust path that inserts/updates a JE with `apply_balance`/`reverse_je_balance` outside `post_je_core`/`unpost_je_core`, add the period guard in lockstep. Same trap class as the path-to-regexp literal-segment ordering one: easy to miss because the happy path compiles and works.
