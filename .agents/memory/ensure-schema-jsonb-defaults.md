---
name: Drizzle JSONB column defaults
description: Runtime reconciliation behavior for new company JSONB preference columns.
---

For Replit-managed PostgreSQL, do not add startup DDL to repair JSONB defaults or constraints. Generic reconciliation may leave a newly declared JSONB column nullable and defaultless; keep application reads safe for null during the additive transition and use the supported development/publish schema flow for constraints.

**Why:** The supported schema-change flow is development schema application followed by Publish. Adding a third startup-time DDL path can mutate production outside that flow, even when the statements are idempotent.

**How to apply:** Declare additive JSONB fields in the schema, provide values in application writes, and treat legacy null as the documented empty state. Do not force Drizzle push against the broad ERP schema; use the project-approved migration process before adding database constraints.
