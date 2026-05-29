---
name: POS Desktop document numbering series
description: How user-controlled document numbering (prefix/next/padding) works in the standalone POS Desktop app
---

POS Desktop lets the operator fully control document numbers per doc type (sales invoice, sales return, purchase, purchase return, + others) via the "أرقام المسلسلات" screen.

**Architecture:**
- `number_series_local(doc_type TEXT PK, prefix, next_number, padding)` table seeded once with `INSERT OR IGNORE ... SELECT COALESCE(MAX(id),0)+1` from each existing doc table, so numbering continues from pre-feature data rather than resetting.
- `next_doc_no(conn, doc_type)` reads/formats (`prefix + zero-padded next_number`)/increments INSIDE the posting transaction; all 5 `next_*_no` fns delegate to it. It hard-errors on a missing row rather than silently inventing a number.

**Collision rule (the durable lesson):** duplicate document numbers are prevented ONLY by DB `UNIQUE` constraints on the invoice_no/return_no columns. Lowering "next number" below already-used values, or two concurrent writers, can produce a *transient* create failure on UNIQUE (never a persisted duplicate). The NumberSeriesAdmin UI warns the operator about the lower-than-existing case. If you add a new numbered doc type, you MUST add its column UNIQUE constraint too, or the numbering screen can mint real duplicates.
