---
name: Schedule-generating modules need one shared advisory lock
description: Monthly-schedule modules (adjustments, depreciation-like) — edit-with-re-spread vs auto-posting concurrency rule
---

Rule: when a module both AUTO-POSTS schedule rows (scheduler / bulk run / per-doc generate) and allows EDITING the plan with re-spread of the remaining balance, every mutator must take the SAME `pg_advisory_xact_lock(class, parentId)` inside its transaction, and RE-READ the parent row under the lock.

**Why:** `SELECT … FOR UPDATE` on the parent row alone does NOT block generation — generation inserts child run/JE rows without touching the parent row, so an edit can compute `recognized`/`remainingMonths` from a stale run set and persist a wrong monthly amount.

**How to apply:** monthly accounting adjustments use class 74001 with the adjustment id across PUT (financial edit), `/generate`, and the run-due helper used by both the route and the hourly scheduler. Generation paths also re-read monthlyAmount/endDate/status under the lock because a concurrent edit may have just re-spread them. Session-level `pg_advisory_lock` is unsafe over a pool (lock/unlock may land on different connections) — always the xact variant inside `db.transaction`.
