---
name: protected source JE identity on unpost→repost
description: Preserve the exact linked JE row and number for protected sources; legacy unprotected entries retain reservation-based reuse.
---

# Retain the same linked JE on unpost → edit → repost

**Rule:** If either a source document or its linked journal entry is sequence
protected, unposting must keep the same JE row, number, lines, and source FK,
changing only its status to draft in the same transaction as the source update.
Reposting rebuilds that retained row in place and preserves its `docNumber`.
Unprotected legacy records keep the reservation/delete/recreate path.

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

**Why:** A protected document and its linked JE are one audit identity; keeping
only the number while replacing the row loses that identity and risks duplicate
or detached accounting history. Legacy reservations still prevent sequence gaps
without changing the counter.

**How to apply / gotchas:**
- `takeReservedJeNumber` MUST be a single atomic `DELETE … RETURNING` — a
  select-then-delete lets two concurrent reposts of the same doc both read the
  reservation and mint a DUPLICATE number. (Architect-flagged, fixed.)
- When a repost runs inside `db.transaction`, PASS that tx (`dx`) all the way
  down: `resolveJeNumber({…, dx})` → `takeReservedJeNumber(…, dx)`, so the
  reservation DELETE participates in the outer tx. Otherwise a rollback LOSES the
  reservation (it committed on global `db`) and the retry mints a fresh number —
  breaking legacy reuse. The fresh-draw fallback (`nextSequenceNumber`) opens its
  OWN tx by design; a rollback there only leaves an acceptable sequence gap,
  never a duplicate — don't try to nest it into the caller tx.
- Reservations are polymorphic (no FK to source docs). Safe because SERIAL ids
  are not reused within a table; the only residual risk is id reset/import where
  an orphaned reservation could be consumed by a different logical doc — low
  frequency, accepted.
- Protected same-row lifecycle handling covers sales and purchase invoices and
  returns, receipt/payment vouchers, goods receipts/deliveries, sister transfers,
  returns and settlements, account notes, payroll runs and payroll payments.
  Manual posting of a linked source JE remains status-only; it must not repost
  the source document or repeat its stock/tax effects.
- The shared retention helper validates company, JE type, and draft state before
  rebuilding. If adding another source-linked type, preserve the FK and row in
  its unpost transaction whenever either side is protected; keep reservations
  only for legacy unprotected paths.
- When the builder already runs inside a tx (or opens one for JE insert),
  resolveJeNumber must be called INSIDE with `dx: tx` so a rollback restores
  the reservation (vouchers were initially resolved pre-tx — wrong).
- The table is created in `ensureSchema.ts` custom-DDL block (declared drizzle
  tables are NOT auto-created); reaches prod only via Publish.
- Additive + fail-safe: any mismatch degrades to the prior "draw a new number".

## Branch normalization exception

If a legacy source row had no branch and posting now resolves a real branch from
its cash box, bank, or employee, persist that branch and intentionally discard
the pre-normalization reservation before drawing a fresh JE number. Reusing the
old reservation can carry a branch-0 number into the corrected branch forever.

**Why:** Employee custody exposed this in production: the source and employee
were branchless, while the selected main cash box belonged to the main branch.
The first JE consumed the branch-0 counter; a later repost correctly acquired
the main branch but kept reusing the old branch-0 document number.

**How to apply:** Treat this as a one-time source-branch backfill. Once the
resolved branch is stored on the source row, normal unpost→repost reuse resumes.
Do not broadly compare old numbers with the current counter; legitimate reposts
may reuse much older numbers.

## Payroll payment (صرف الرواتب)
- payment JE keyed `payroll_pay:runId` (sub `hr_payroll`); run's own JE keyed `payroll_run:runId` — two independent reservation keys per run.
- **Race lesson:** payroll `/pay` and `/unpost` must BOTH `SELECT … FOR UPDATE` the run inside ONE tx — a pre-tx status check lets a concurrent pay attach a payment JE to a run being reverted to draft.
