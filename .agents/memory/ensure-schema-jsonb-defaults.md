---
name: Drizzle JSONB column defaults
description: Runtime reconciliation behavior for new company JSONB preference columns.
---

When adding a non-null JSONB preference with an object default, verify the column after startup reconciliation. Generic column healing may add it without a SQL default or NOT NULL constraint even though the Drizzle declaration has both.

**Why:** The reconciler did not translate the object default into SQL when creating a missing JSONB column, so a later `ADD COLUMN IF NOT EXISTS ... DEFAULT` left the already-created column nullable and defaultless.

**How to apply:** After generic column reconciliation, explicitly set the SQL default, backfill existing NULL rows, and then enforce NOT NULL in the idempotent schema-healing path. Confirm `information_schema.columns` reports the expected default and nullability.
