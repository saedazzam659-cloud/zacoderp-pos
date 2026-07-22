---
name: Report routes inside module routers need their own permission scope
description: Read-only report endpoints living in a module-gated router must be registered before the router-level gate with the reports module gate.
---

Rule: when a screen is UI-gated by `accounting_reports` but its API endpoint lives inside a router globally guarded by another module gate (e.g. `requireModulePermission("accounts")` in adjustments.ts), report-only users get 403. Register the report route BEFORE the `router.use(requireModulePermission(...))` line, with its own `requireModulePermission("accounting_reports") + moduleAudit("accounting_reports")` middlewares (Express applies router.use only to routes registered after it).

**Why:** architect review caught this on the adjustments movement-schedule report — company/module gating happens per-router, and the FA schedule got away with it only because both screen and router share the same module key.

**How to apply:** any new report endpoint added to an existing CRUD module router where the UI permKey differs from the router's module key.
