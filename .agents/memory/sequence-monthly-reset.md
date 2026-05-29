---
name: Sequence monthly reset (تصفير شهري)
description: Rules for the monthly-reset toggle on the document-numbering engine (zatca-invoicing web ERP, NOT pos-desktop).
---

# Monthly reset on document numbering

The web ERP numbering engine (`artifacts/api-server/src/lib/sequences.ts` issuance +
`artifacts/api-server/src/routes/sequences.ts` `/peek`) supports a per-sequence
`monthly_reset` boolean. Counters live in `sequence_counters`, keyed by
**(sequence_id, branch_id, period)**.

**Rule — counters are bucketed by `period`, one row PER month when reset is on.**
- `monthly_reset = false` → `period = ""` (sentinel): ONE continuous row per
  (sequence, branch). Behaviour is byte-identical to the pre-period engine — do not
  touch this path.
- `monthly_reset = true` → `period = "YYYY-MM"`: each month is its OWN independent
  counter row.
**Why:** the OLD model used a SINGLE row + a `last_period` stamp, so it could only
remember ONE month. Entering documents out of order across months (May → April → May)
made the single counter reset/overwrite → wrong "next number" AND duplicate document
numbers (e.g. duplicate QU-05-0001). Per-period rows make each month immune to the
others. Regression encoded in `__tests__/sequence-monthly-reset.test.ts`
("out-of-order month entry…").
**How to apply:** issuance and `/peek` MUST compute the same bucket key
(`monthlyReset ? "YYYY-MM" : ""`) from the SAME effective date that renders `{MM}`,
or the badge drifts from the issued number.

**Rule — a new month's counter SEEDS from the true max already issued that month.**
First touch of a (branch, month) bucket seeds at
`GREATEST(start_number, maxIssuedForThatMonthFromLogs + 1, legacy-"" adoption)`.
`maxIssuedForThatMonth` is parsed from `sequence_logs` (LIKE `${prefix}${renderedMonth}%`,
trailing-digits regex). **Why:** lets a month self-heal — after the per-period upgrade,
or after clearing a corrupted counter, the bucket rebuilds just above the real max so it
never re-emits an already-used number. `sequence_logs` has no branch column, so in a
multi-branch tenant this is the company-wide month max → only ever seeds a NEW branch
HIGHER (a gap), never lower. Gaps acceptable, reuse is not.

**Rule — legacy `""` row is adopted ONCE then retired when reset is toggled on.**
A sequence run without reset has a single `""` row. The first issuance after toggling
reset ON adopts that running number for the current month (so it never reuses), then
stamps the `""` row's `last_period` to retire it so later months reset cleanly. Adopt
only when the `""` row's `last_period` is NULL or equals the current month. The `/peek`
preview mirrors the seed read-only — it must NOT retire (only real issuance does).

**Rule — monthly_reset is hard-blocked without a month token.**
**Why:** without `{MM}`/`{M}` in `monthPattern`, every month re-issues the same formatted
string → unique-index collision. Server `validatePayload` rejects `monthlyReset=true`
unless the pattern contains `{MM}` or `{M}`.

**Gotcha — PATCH must persist behavior toggles in BOTH places.** A new sequence column
must appear in the PATCH `existing` snake_case normalization AND in the final
`tx.update(...).set({...})` — computing it only into the `merged` object silently drops
it on update.

**DB migration note:** drizzle push in this repo is interactive and hangs from the
agent shell; apply additive DDL via direct
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` / `CREATE UNIQUE INDEX IF NOT EXISTS`
through the SQL tool instead. Clearing corrupted monthly-reset counters
(`DELETE FROM sequence_counters sc USING sequences s WHERE sc.sequence_id=s.id AND
s.monthly_reset=true`) is safe — they rebuild from `sequence_logs` on next touch. The
same DDL must be applied to PRODUCTION before/at deploy or runtime logic and schema
diverge.

## Next-number badge (peek) MUST match the issuance branch

Counters are per-(sequence, branch, period). The `useNextSequenceNumber` peek hook and
the document form's POST must target the SAME branch, or the badge reads the wrong
counter.
**Symptom:** badge frozen at the start number while each save increments correctly.
**Cause:** the form submits a selected `branchId` so issuance advances that branch's
counter, but the peek hook sent no branch → read the company-wide branch-0 sentinel and
fell back to `start_number`.
**How to apply:** any form that submits a branch AND shows a next-number badge must pass
that branch as the 4th arg of `useNextSequenceNumber(txType, enabled, date, branchId)`.
