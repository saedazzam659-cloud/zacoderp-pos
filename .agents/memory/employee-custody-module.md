---
name: Employee Custody (العُهد) module
description: How the SAP-style custody/imprest module relates to loans, its GL model, and shared gates.
---

# Employee Custody (العُهد / imprest)

A SEPARATE module from loans, SAP-style. Custody is **NOT** salary-deducted (loans are).

**Lifecycle + GL** (builders in `hr-journals.ts`):
- issue/disburse → DR custody (COA **11082**) / CR cash|bank
- settle each expense/invoice line → DR expense / CR custody
- return remaining → DR cash|bank / CR custody
- remaining = amount − settled − returned (auto-computed)

**Decisions (why):**
- Reuses the **`hr_loans` permission key** (no new RBAC key) to avoid the multi-place gate sync
  (`COMPANY_MODULE_GATE` + Layout group-perms) — see `module-gate-sync`.
- Custody receivable account 11082 sits under the SAME parent as loans 11081; `resolveHrAccounts`
  falls back to 11081 if 11082 unlinked.
- Loans type dropdown filters out `advance`/`عُهدة` from *selectable* options but keeps the
  `TYPES["advance"]` label for legacy-row display.

**Concurrency + tenant safety (required, found in review):**
- All mutating endpoints (disburse/settle/return/delete-settlement) lock the custody row with
  `.for("update")` inside the tx — a bare read-then-write races into double-disburse / stale-aggregate.
- Validate every mutable foreign id (employeeId, custodyAccountId, expenseAccountId, branchId)
  belongs to the company BEFORE posting — the router only blocks anonymous, not cross-tenant ids.
