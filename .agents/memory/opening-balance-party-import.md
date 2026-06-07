---
name: Opening-balance party import (customers/suppliers)
description: How bulk opening-balance imports build/replace a single draft JE safely, and the integrity rules that must hold.
---

# Opening-balance bulk import (customers & suppliers)

Bulk upload of opening balances for customers/suppliers aggregates all rows into
ONE balanced journal entry (`entryType="opening"`, `status="draft"`),
counter-balanced against the Opening Balance Equity account (mapping
`warehouse/opening_balance`, fallback account code `3301`). Saved as draft so the
user posts it manually from مركز الترحيل (drafts have zero report impact).

The prior import is identified by a hidden marker embedded in the JE description
(`[ob:customers]` / `[ob:suppliers]`), NOT a dedicated column.

## Integrity rules that MUST hold (each was a real review finding)

- **Replace = full replace, including clear.** A re-upload that resolves to zero
  applied lines must still DELETE the previous marker JE (leave nothing behind),
  not early-return. Otherwise stale balances stay active.
  **Why:** "re-upload replaces entirely" is the user's contract.
- **Guard the period of the JE being DELETED, not just the new date.** Deleting a
  prior opening JE that sits in a closed/locked period silently mutates locked
  history. Check `assertWritableForPeriodId` on every prior marker JE before
  deleting; 423 if any is locked.
- **Serialize the replace.** Delete-then-insert is race-prone — two concurrent
  imports of the same party type can both pass the "find previous" check and
  double-insert. Wrap delete+insert in ONE `db.transaction` guarded by
  `pg_advisory_xact_lock(cid, lockKey)` (distinct lockKey per party).
- **Round to 2dp BEFORE accumulating totals**, not only on the net counter line.
  Rounding per-line amount but summing unrounded floats can leave the entry
  unbalanced at 2dp on edge decimals.

## Other notes

- Allocate the doc number via `nextSequenceNumber` OUTSIDE the advisory-locked
  transaction (it runs its own atomic tx; nesting a second pooled connection
  inside the held transaction risks pool exhaustion/deadlock). QYD fallback runs
  inside the tx using `tx`.
- Routes `POST /import/opening-balances` live in `customers.ts`/`suppliers.ts` and
  MUST be registered BEFORE `/:id` (Express 5 / path-to-regexp 8 quirk).
- Frontend: two tabs in `GeneralSettings.tsx` export a pre-filled template
  (id, name, balance, type) and upload it back.
