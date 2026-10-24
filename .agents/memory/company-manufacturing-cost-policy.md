---
name: Company manufacturing costing policy
description: Company-wide default and stage-level posting contract for new production orders.
---

The company-level comprehensive-costing toggle must only set the resource-costing version when a new production order is first created. Editing or replaying an existing order must preserve its saved costing version and snapshots. Continue using the existing stage-resource, posted-source, WIP, and settlement paths; do not introduce parallel expense or posting behavior.

For v1 orders, the approved accounting target is to post material and resource costs to WIP as each production stage completes. Each BOM material belongs to an explicitly selected stage; stock and its cost are issued at that stage, not duplicated from an order-start issue. Payroll, depreciation, and electricity may use provisional amounts when the actual monthly source is not yet posted; when the actual source posts, clear the provisional accrual and capitalize only the actual variance. Source-period ownership follows the production period, not the journal-entry date.

**Why:** The user confirmed that production must not wait for monthly payroll or depreciation journals and that stage completion should carry the full stage cost. Explicit material-to-stage links prevent guessed allocation; deferring issue prevents double capitalization.

**How to apply:** Preserve v0 behavior. In v1, coordinate stage material issue, resource posting, monthly-source settlement, capacity claims, final receipt, and cancellation/reversal as one lifecycle. Do not report stage posting as complete until every path and reversal is implemented and tested.

**Why:** The approved company policy is a prospective default. Historical orders and their accounting evidence must not change when a company enables or disables the setting.

**How to apply:** Enforce the policy server-side across every order-creation path. The UI may reflect the setting, but backend creation remains authoritative.
