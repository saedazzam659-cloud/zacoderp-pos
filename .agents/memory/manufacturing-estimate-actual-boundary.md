---
name: Manufacturing estimate versus actual
description: Per-employee manufacturing labor cost, frozen payroll provisions, and depreciation evidence.
---

Smart Manufacturing must cost each assigned employee separately from the employee's gross pay plus frozen annual-leave, travel-ticket, and Saudi end-of-service provision amounts, less any already-posted manufacturing offsets for those same provisions. Divide by 30 times the employee's contract daily hours (240 hours for an eight-hour day), then multiply by that employee's actual stage hours. Do not flatten employees into one hourly average, reconstruct missing historical provisions, or silently rewrite saved or posted history. Reconcile an existing posted payroll source through the established allocation/driver flow; stage evidence is not a second payroll journal.

**Why:** The user requires salary plus leave, ticket, and Saudi EOS provisions at a 240-hour monthly basis, with no duplicate recognition and no rewriting of posted history. Employee costs differ, and missing frozen values cannot be safely inferred from current contract settings.

**How to apply:** Require the posted payroll run's frozen provision snapshots and a contract valid for that payroll period; subtract posted provision settlements once by employee and source journal. Apply each employee's own rate to their actual stage hours and reconcile only through the existing source allocation and driver-reconciliation lifecycle. Keep route estimates read-only and separate from posted order costs. Depreciation applies only through a machine stage linked to an eligible fixed asset with a valid configured hourly rate or posted depreciation divided by approved operating hours; show missing inputs explicitly. Never reconstruct or silently update historical snapshots.
