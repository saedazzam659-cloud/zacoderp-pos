---
name: HR violations / asset custody / travel invariants
description: Invariants for the registered-violations→payroll deduction pipeline, asset custody (عهدة عينية), travel exit/return, and attendance workday defaults.
---

**Violations → payroll deduction:**
- Payroll run create is server-authoritative: inside one tx it locks pending `deduct_from_salary` violations FOR UPDATE, derives each line's `violationDeduction` from the LOCKED rows (adjusting totalDeductions/netSalary by delta vs the client preview), then marks EXACTLY those ids `deducted` + payrollRunId. Never trust the previewed figure.
- **Why:** a violation can be edited/waived between preview and save; out-of-tx bulk-update consumed rows the run lines didn't reflect.
- Violation PUT/DELETE use conditional WHERE `status <> 'deducted'` (409 on zero rows) — the pre-read check alone is TOCTOU.
- Draft-run delete releases its violations (pending, payrollRunId=null) + deletes the run in ONE tx.
- JE: violationDeduction rides the existing "استقطاعات أخرى" 21053 credit (folded into otherDeduction in buildPayrollJournal) — no new account mapping.

**Asset custody (عهدة عينية):** administrative only, NO journal entry; one live custody per asset via partial unique index (status='delivered'), 23505→Arabic 409; deliver/return syncs `fixed_assets.custodian_employee_id` both ways. Routes live under /hr/custodies with `/asset` paths registered BEFORE `/:id`.

**Travels (الخروج والعودة):** `/alerts` returns upcomingReturns for status='out' with expectedReturnDate ≤ today+7 (daysLeft tagged); setting actualReturnDate flips status out↔returned.

**Attendance defaults:** workday start/end come from face-AI settings (`attendance_ai_settings.workdayStart/End` via faceApi.getSettings()), fallback 08:00/17:00 — never re-hardcode.

**Iqama/permit badge:** red at ≤152 days (5 months), amber ≤240; label "باقي X شهر و Y يوم".
