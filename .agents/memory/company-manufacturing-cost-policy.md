---
name: Company manufacturing costing policy
description: Company-wide default for resource costing on newly-created production orders.
---

The company-level comprehensive-costing toggle must only set the resource-costing version when a new production order is first created. Editing or replaying an existing order must preserve its saved costing version and snapshots. Continue using the existing stage-resource, posted-source, WIP, and settlement paths; do not introduce parallel expense or posting behavior.

**Why:** The approved company policy is a prospective default. Historical orders and their accounting evidence must not change when a company enables or disables the setting.

**How to apply:** Enforce the policy server-side across every order-creation path. The UI may reflect the setting, but backend creation remains authoritative.
