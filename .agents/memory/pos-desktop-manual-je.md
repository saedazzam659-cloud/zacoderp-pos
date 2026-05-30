---
name: POS Desktop manual journal entries
description: How offline manual JE CRUD stays isolated from the system-document JE path and how draft/posted gating works
---

# POS Desktop manual journal entries (offline)

Manual JE CRUD (`journal_entry_{create,update,post,unpost,delete,detail,peek_number}`) uses a **dedicated** `Manual*` struct family (`ManualJeInput/ManualJeLine/ManualJeDetail`) and its own line-insert path (`write_manual_lines`). It does NOT reuse the shared `JournalEntryLine` struct or `insert_journal_entry`.

**Why:** ~24 system-document call-sites (sales/purchase/POS/payroll/production/stock) build JEs through `insert_journal_entry` with fixed account literals and always post immediately. Adding manual-only concerns (draft status, manual doc# override, per-line cost center, entry type, VAT tool) to that shared struct would ripple into all of them. Keeping a parallel manual path means the system path stays untouched.

**How to apply:**
- Draft entries call `write_manual_lines(post=false)` → NO `apply_balance`, so they never touch `accounts_local.balance`.
- Drafts are excluded from all 4 financial reports because `report_ledger_lines` filters `WHERE e.status='posted'`. Posting/unposting/editing a posted entry must reverse the old impact first (`reverse_je_balance` swaps debit/credit) before re-applying — never double-apply.
- `load_manual_guard` rejects edit/post/unpost/delete when `source_type` is non-null and != `'manual'` (system entries must be unwound from their origin document, not edited directly).
- `entry_no` is UNIQUE; a manual doc# collision is mapped to a friendly Arabic message via `map_entry_no_conflict`. The list badge peeks the next number WITHOUT consuming the sequence (`peek_number` reads, create consumes via `next_entry_no`).
- New columns (`entry_type` default `general`, `status` default `posted`) are added by idempotent ALTERs so pre-existing rows keep their already-applied-to-balance behavior.
