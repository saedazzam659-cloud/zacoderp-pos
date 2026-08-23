---
name: HR effective-dated mutations
description: Rules for changing employee assignments and transfers without rewriting payroll history.
---

Employee transfer and project/cost-center assignment changes are effective-dated: historical rows are immutable, while a new current/future row closes the previous open row on the preceding day.

**Why:** Payroll snapshots freeze assignment context. A concurrent payroll run or a UTC/local-date mismatch can otherwise let a later edit rewrite the period from which payroll was calculated.

**How to apply:** Use the same tenant+employee advisory lock for assignment mutations and payroll snapshot creation. Evaluate “today” in the Saudi business timezone, reject overlaps, and never shorten a row through a frozen snapshot period.