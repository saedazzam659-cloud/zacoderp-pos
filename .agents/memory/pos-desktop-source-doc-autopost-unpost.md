---
name: POS Desktop source-doc auto-post + unpost-deletes-JE
description: Auto-post-on-save default, and the FK ordering rule when unposting deletes the JE
---

**Auto-post default is ON** for source documents: `resolve_auto_post` (and
`posting_settings_get`) default to `true` in `accounting.rs`. Every source document
(sale/purchase/financial_tx/goods_receipt/goods_delivery/supplier_settlement/…)
posts its GL + stock immediately on save unless the per-company toggle is explicitly off.

**Unposting a SOURCE doc reverses GL+stock AND DELETES its journal entry** (source docs
do not keep a draft JE around). Only **manual** journal entries keep the classic manual
post ⇄ unpost lifecycle (unpost flips status to draft, never deletes).

**FK ordering gotcha:** the source row carries a `je_id` FK → `journal_entries`. You MUST
`UPDATE <source> SET je_id = NULL` BEFORE `DELETE FROM journal_entries` at EVERY unpost
site, all inside the same transaction. Deleting the parent JE while the child still points
at it throws SQLite `FOREIGN KEY constraint failed` — this was the original broken
فك الترحيل bug. When adding a new source-doc type with an auto-posted JE, replicate the
null-then-delete order in its unpost path.
