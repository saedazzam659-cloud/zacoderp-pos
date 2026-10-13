---
name: Company operational reset boundary
description: Scope and safety rules for the SuperAdmin company-data reset tool.
---

The reset applies only to the exact primary company selected and name-confirmed by SuperAdmin. Never include internal demo workspaces or demo-linked companies, and never reset a company with any ZATCA registration credentials/state. Preserve company identity, master/setup data, settings, users, and platform evidence; delete only company-scoped operational records and reset numbering state. Each database mutation must be limited to the selected company ID; unclassified schema changes fail closed.

**Why:** The user explicitly requires the reset to affect one named primary company only, never demo or ZATCA-linked companies, and never touch another tenant's activity.

**How to apply:** Keep the exact-name check and eligibility checks on the server, repeat them inside the reset transaction, show a preflight preview, and verify the preview has not gone stale before deleting. If associated archived files or schema dependencies are unsupported, block the reset rather than silently leaving an incomplete or cross-tenant result.
