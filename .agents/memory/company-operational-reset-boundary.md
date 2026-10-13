---
name: Company operational reset boundary
description: Scope and safety rules for the SuperAdmin company-data reset tool.
---

The reset applies only to the exact primary company selected and name-confirmed by SuperAdmin. Never include internal demo workspaces or demo-linked companies, and never reset a company with any ZATCA registration credentials/state. Preserve company identity, master/setup data, settings, users, and platform evidence; delete only company-scoped operational records and reset numbering state. Each database mutation must be limited to the selected company ID; unclassified schema changes fail closed.

The owner explicitly authorizes the confirmed SuperAdmin reset to delete sequence-protected documents and restart numbering for that selected company. This exception must exist only inside the validated reset transaction, be bound to that company ID, and never disable sequence protection globally or persist outside the transaction.

Before deleting operational records, reset must unpost posted documents through their normal reversal behavior, in dependency-safe order. Do not merely flip posted/status flags or delete posted records directly; if a required unpost is blocked, abort and roll back the entire reset rather than bypassing that business safeguard.

**Why:** The owner clarified that company reset is an intentional administrative wipe, including protected records, with numbering restarted from the beginning.

**How to apply:** Acquire the sequence-protection company lock, run the existing exact-name/eligibility/stale-preview checks, then set a transaction-local company-scoped reset marker immediately before deletion. Keep the trigger blocking all protected deletes unless the row's company matches that marker.

**Why:** The user explicitly requires the reset to affect one named primary company only, never demo or ZATCA-linked companies, and never touch another tenant's activity.

**How to apply:** Keep the exact-name check and eligibility checks on the server, repeat them inside the reset transaction, show a preflight preview, and verify the preview has not gone stale before deleting. If associated archived files or schema dependencies are unsupported, block the reset rather than silently leaving an incomplete or cross-tenant result.
