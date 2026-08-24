---
name: Employee Custody (العُهد) module
description: How the SAP-style custody/imprest module relates to loans, its GL model, branch numbering, and shared gates.
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
- Custody disbursement/return posting branch precedence is document branch → selected
  cash/bank branch → employee branch. **Why:** a branchless custody paid from a
  branch-owned bank must consume that branch's unified journal counter, not the unrelated
  company-wide/null-branch stream. Apply the same resolved branch to both the JE header
  and sequence allocation.

**Concurrency + tenant safety (required, found in review):**
- All mutating endpoints (disburse/settle/return/delete-settlement) lock the custody row with
  `.for("update")` inside the tx — a bare read-then-write races into double-disburse / stale-aggregate.
- Validate every mutable foreign id (employeeId, custodyAccountId, expenseAccountId, branchId)
  belongs to the company BEFORE posting — the router only blocks anonymous, not cross-tenant ids.

## Unpost cascade for custody & loan JEs (2026-07-28)
JE unpost (journal-entries /:id/unpost) cascades HR disbursements: custody JE types are
THREE (employee_custody, employee_custody_settlement, employee_custody_return — check
hr-journals.ts, not just the base type). Disbursement unpost clears
disbursement_journal_id + DELETES the JE (blocked while settlements/returns exist);
settlement/return unpost deletes the settlement row + rolls settled/returned back.
Loan disbursement JE (locked type, marker `JE#<id>` in employee_loans.notes) is handled
BEFORE ensureNotLocked; blocked once paidAmount>0. All checks re-validated inside the tx
under FOR UPDATE. **Why:** a bare status flip left the source row "disbursed" with the
صرف button gone forever.

## Dangling disbursement link self-heal
If the disbursement JE was deleted OUTSIDE the unpost cascade (e.g. old draft deleted
directly), custody.disbursement_journal_id points at a dead JE and the صرف button hides
forever. The custody LIST endpoint self-heals: checks referenced JE ids exist, NULLs
dangling links on read. **Why:** legacy rows broken before the cascade existed can't be
fixed by unposting — there's no JE left to unpost.
