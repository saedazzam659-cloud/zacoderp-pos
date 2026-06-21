---
name: POS Desktop supplier AP account NULL crash
description: Why offline purchase save fails with "Invalid column type Null at index: 0, name: ap_account_id"
---

`suppliers_local.ap_account_id` is a NULLABLE column. A supplier can end up with
NULL there (created by an older build before the default-2100 logic, pulled from
cloud sync, or any non-`suppliers_create` path). Several read sites in
`accounting.rs` read it as a non-nullable `i64` via `r.get(0)`, which makes
rusqlite reject NULL with the rusqlite error **"Invalid column type Null at
index: 0, name: ap_account_id"** — surfaced to the user as a failed purchase save.

**Rule:** NEVER read `ap_account_id` (or any nullable GL-link column) as a bare
`i64`. Use the existing helper `supplier_ap_account(conn, supplier_id)` which reads
it as `Option<i64>` and falls back to the default payables control account `2100`.
The same NULL-tolerant pattern lives in `post_party_opening_balance`.

**Why:** the supplier's own payables sub-account is optional by design (comment:
"falls back to 2100 when absent"); the default control account is the correct
substitute. Reading it strictly turns an optional field into a hard crash on the
exact documents (credit purchase invoice, purchase return, supplier voucher) the
user needs most.

**How to apply:** any new code that needs a supplier's AP account must call
`supplier_ap_account`, not an inline `SELECT ap_account_id … r.get(0)`. The same
caution applies to other nullable account links — `cash_boxes_local.account_id`
and `banks_local.account_id` are also nullable (currently set at creation, so
lower risk, but read as bare i64 in `resolve_payment_credit_account`'s cash/bank
arms). Rust compiles only in CI, so hand-verify these reads before tagging.
