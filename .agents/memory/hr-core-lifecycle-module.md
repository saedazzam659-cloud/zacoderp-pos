---
name: HR Core lifecycle module
description: Design invariants of the /api/hr-core employee-lifecycle extension (salary adjustments, transfers, terminations, unified history)
---

The HR Core extension (routes/hr-core.ts, mounted at /api/hr-core; frontend EmployeeProfile.tsx tabbed page at /hr/employees/:id/profile) adds employee-lifecycle tables on top of the pre-existing HR module. Invariants:

- **Never duplicate legacy HR**: contracts/leaves/attendance/loans/payroll/custody/EOS-calc live in routes/employees.ts and their own screens; hr-core only adds org catalogs, salary-adjustment history, transfers, evaluations, contacts, dependents, qualifications, certificates, documents, employee_history, terminations.
- **History is append-only**: every material mutation (salary adjust + scheduled apply, transfer create/apply/end, termination create/cancel, evaluation create) writes employee_history in the SAME transaction. Salary/transfer prev-values snapshot the live employees row at mutation time, never the form.
- **API-level authz**: router maps HTTP method → PermAction under hr_employees; mutating salary-adjustment routes additionally require hr_payroll edit. Frontend PermRoute is cosmetic.
- **Scheduled apply discipline**: /apply endpoints must (1) FOR UPDATE lock the employees row FIRST, then the lifecycle row, (2) reject if effectiveDate is in the future, (3) log history. Temporary assignments (isTemporary) never mutate the employees row; /end is temporary-only — permanent moves are corrected by a new transfer.
- **Termination**: one active record per employee; sets status (resigned/terminated) + endDate, never deletes. Cancel restores the ACTUAL prior status/endDate from the termination's own history row (prevValue), not hardcoded "active".
- **Why:** architect review found the initial version had client-only authz, un-gated scheduled applies (stale-snapshot races), and hardcoded cancel-restore — these rules fix data-corruption paths.
- **How to apply:** any new hr-core lifecycle endpoint must follow the same lock-order + due-date gate + in-tx history pattern; new org-catalog FKs must be tenant-validated (assertDept/getEmployee).
