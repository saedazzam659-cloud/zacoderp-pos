---
name: JE number reuse on unpost→edit→repost
description: How a source document keeps the SAME journal-entry number across an unpost→repost cycle instead of leaving a permanent gap in the journal_entry sequence.
---

# Reuse the same JE number on unpost → edit → repost

**Rule:** Unposting a source document (invoice/return/…) DELETES its journal
entry; re-posting must reuse the SAME `journal_entry` number, not mint a fresh
one. Mechanism: stash the number at unpost time, consume it at repost time.

- A dedicated `je_number_reservations` table keyed UNIQUE by
  `(company_id, source_type, source_id)` holds one live reservation per source
  doc (`doc_number` + `branch_id`).
- `reserveJeNumberFromEntry(cid, sourceType, sourceId, jeId)` is called in EVERY
  unpost handler RIGHT BEFORE the JE is deleted (upsert, so repeated cycles are
  fine).
- `resolveJeNumber({companyId, sourceType?, sourceId?, …})` replaces the direct
  `nextSequenceNumber(cid,"journal_entry",…)` call inside the centralized
  `createJournalEntry` helpers — it returns a reserved number (consuming it) if
  present, else draws the next number, else null (caller falls back to source
  docNumber, legacy behavior).

**Why:** Before this, unpost→repost burned a new number every cycle, leaving
permanent gaps in the continuous JE series (financial reports filter
`status='posted'`, so deleting the draft-on-unpost is safe — the gap was the
only damage). Reuse never touches the sequence counter, so it can never roll the
counter back or mint a duplicate.

**How to apply / gotchas:**
- `takeReservedJeNumber` MUST be a single atomic `DELETE … RETURNING` — a
  select-then-delete lets two concurrent reposts of the same doc both read the
  reservation and mint a DUPLICATE number. (Architect-flagged, fixed.)
- Reservations are polymorphic (no FK to source docs). Safe because SERIAL ids
  are not reused within a table; the only residual risk is id reset/import where
  an orphaned reservation could be consumed by a different logical doc — low
  frequency, accepted.
- Wired for `purchase_invoice`, `purchase_return`, `sales_invoice`,
  `sales_return` (via the shared `createJournalEntry` in purchasing.ts/sales.ts).
  Inline-mint JE paths (vouchers, GRN/GDN, sister, HR, FA, production multi-JE)
  still mint fresh — extend with the same reserve+resolve pair when needed
  (production needs DISTINCT source_type keys per JE: issue/receipt/complete).
- The table is created in `ensureSchema.ts` custom-DDL block (declared drizzle
  tables are NOT auto-created); reaches prod only via Publish.
- Additive + fail-safe: any mismatch degrades to the prior "draw a new number".
