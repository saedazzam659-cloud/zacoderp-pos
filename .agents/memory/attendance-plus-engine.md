---
name: Attendance-plus engine invariants
description: Web HR attendance & time management module (attendance-plus) — single-bucket-per-minute engine, dedupe, lock/transfer guards
---

## Single-bucket-per-minute partition (عدم التكرار — the spec's top rule)
`computeDay` must partition the FULL schedule span [workStart, workEnd]:
`span = workedInSched + perm(absent-only) + lateRaw + earlyRaw + break + missing`.
**Why:** deriving `missing` residually from *reported* (grace-zeroed) late/early leaks forgiven grace minutes into missing and lets worked exceed scheduled when break is subtracted inconsistently. Use RAW late/early interval minutes in the partition; grace only suppresses *reporting*. Break allowance consumes mid-day gaps first; excess gap ≡ missing. Permission minutes count ONLY where the employee was actually absent (presence stays "worked").
**How to apply:** any change to the engine must keep the sum-to-span invariant; test with the interval cases (late+perm, grace, absent-with-perm, cross-midnight).

## Other invariants
- Punch dedupe = UNIQUE(employee,date,time,type) + `onConflictDoNothing` → report `{inserted, duplicates}`, never error.
- Payroll transfer-once = UNIQUE(company,period) → 409; `/recalc` must also be gated by BOTH `assertDayOpen` AND `assertPeriodNotTransferred`.
- Lock guards live in shared `lib/attendanceLocks.ts` and gate the LEGACY manual attendance CRUD in routes/employees.ts too — a new mutation path anywhere must call both guards.
- Permission create (overlap check) and approve (monthly balance) run in a tx under `pg_advisory_xact_lock(hashtext('att-perm:cid:emp:day|month'))`; approve's status flip is conditional on the previously-read status (`WHERE status = old`) → 409 on race.
- Cross-midnight shifts: recalc fetches date AND date+1 movements; next-day punches ≤ workEnd fold in, engine offsets times < workStart by +24h.
- recalc never mutates raw movements; skips employees with no data (no absent-row flooding); manual rows (`calcSource != 'engine'`) without movements/permissions are preserved.
- New tables were applied by direct DDL in dev; prod schema syncs at Publish (ensureSchema does NOT create tables).

## Auto-absence policy (اعتبار المتأخر غائباً)
- `attendance_ai_settings.absent_after_min` (null/0=off): computeDay gets `ctx.absentAfterMin`; when lateRaw (pre-grace, permission-overlap already excluded) > cutoff → status "absent" + violation `auto_absent`. Applied in BOTH branches: open-in (no checkout) and full-session — any new status branch must apply it too.
- recalcDay loads the setting once per company call (not per employee).
